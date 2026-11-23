// PasskeyWire.swift: the JSON side of the `Passkey` plugin (passkeys plan,
// Step 1 "Phones"). Pure Foundation: it reads the WebAuthn JSON options the
// page sends into a plain description of the request, and writes the
// credential the system returned back as WebAuthn JSON. No
// AuthenticationServices type appears here, so every function is covered by
// unit tests (PasskeyWireTests) without a system sheet.
//
// Rule R1 of the plan, which this file is half of: a sign-in passkey never
// carries a WebAuthn extension.
//   - Input: the readers below take the members they name and nothing else.
//     The `extensions` member of the options is never looked up, so nothing
//     a page puts there can reach a request. The descriptions have no field
//     that could carry one.
//   - Output: `clientExtensionResults` is always the empty object written
//     here. Nothing the system returned about extensions is read.
// scripts/check-ios-e2ee-commands.mjs (G8d-passkey-extensions) fails the
// build if either half changes.
//
// The relying party is pinned as well. This plugin is driven by the page, so
// it serves exactly one relying party, `PasskeyWire.signInRelyingParty`, the
// domain the app's entitlements associate it with. The readers refuse any
// options whose relying party is not that exact string, and no value read
// from the options is kept: the descriptions have no relying-party field,
// and the plugin hands the constant itself to the system. A passkey kept
// under any other relying party (a backup-only one, later) is therefore out
// of the page's reach through this plugin. The checker pins this too
// (G8d-passkey-rp).
//
// Binary members are base64url WITHOUT padding in both directions; a padded,
// standard-alphabet or otherwise malformed string is refused. Everything
// that is refused throws `PasskeyFailure.failed`: the page learns that the
// options were unusable, never which member or why.
import Foundation

/// The reject codes of the `Passkey` plugin, the same strings the Android
/// plugin uses. Message and code are both the raw value.
enum PasskeyFailure: String, Error, Equatable {
    /// The user closed the system sheet.
    case cancelled
    /// No passkey on this device matches. Reserved for parity with Android:
    /// iOS reports this case as a cancel (see PasskeyPlugin.swift).
    case noCredential = "no_credential"
    /// Below iOS 16, the plugin is not armed, or the app is not associated
    /// with the relying party's domain.
    case unavailable
    /// Anything else, malformed options and a second concurrent call included.
    case failed
}

/// `userVerification` of the options. The raw values are WebAuthn's.
enum PasskeyUserVerification: String, Equatable {
    case required
    case preferred
    case discouraged
}

/// What `create` asks the system for. Every field is listed here; there is
/// deliberately none for extensions (R1) and none for the relying party
/// (always `PasskeyWire.signInRelyingParty`).
struct PasskeyCreationRequest: Equatable {
    let challenge: Data
    let userID: Data
    let userName: String
    let userVerification: PasskeyUserVerification
    let excludedCredentialIDs: [Data]
}

/// What `get` asks the system for. An empty `allowedCredentialIDs` is a
/// discoverable sign-in. No field for extensions (R1) and none for the
/// relying party (always `PasskeyWire.signInRelyingParty`).
struct PasskeyAssertionRequest: Equatable {
    let challenge: Data
    let userVerification: PasskeyUserVerification
    let allowedCredentialIDs: [Data]
}

enum PasskeyRequest: Equatable {
    case create(PasskeyCreationRequest)
    case get(PasskeyAssertionRequest)
}

enum PasskeyWire {
    /// Far above any real options object (a challenge, a few names and a
    /// list of credential ids); a larger string is refused unparsed.
    static let maxOptionsBytes = 64 * 1024

    /// The one relying party this plugin serves: the sign-in passkey's. It
    /// is the host of the `webcredentials:` entry in both entitlements
    /// files, and the only value that ever reaches the system as a relying
    /// party identifier (PasskeyPlugin.swift builds its provider from this
    /// constant, never from the options).
    static let signInRelyingParty = "app.sloga.gg"

    // MARK: base64url

    /// Unpadded base64url text of `data`.
    static func base64urlEncode(_ data: Data) -> String {
        data.base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }

    /// The bytes of unpadded base64url `text`; nil for padding, a character
    /// outside the base64url alphabet, or an impossible length.
    static func base64urlDecode(_ text: String) -> Data? {
        var symbols = Array(text.utf8)
        if symbols.count % 4 == 1 {
            return nil
        }
        for index in symbols.indices {
            switch symbols[index] {
            case 0x41...0x5A, 0x61...0x7A, 0x30...0x39:
                break
            case 0x2D:
                symbols[index] = 0x2B
            case 0x5F:
                symbols[index] = 0x2F
            default:
                return nil
            }
        }
        while symbols.count % 4 != 0 {
            symbols.append(0x3D)
        }
        return Data(base64Encoded: String(decoding: symbols, as: UTF8.self))
    }

    // MARK: options in

    /// Reads the WebAuthn JSON form of the creation `publicKey` options.
    static func creationRequest(optionsJson: String) throws -> PasskeyCreationRequest {
        let options = try topLevelObject(optionsJson)
        try requireSignInRelyingParty(try member(options, "rp"), "id")
        let user = try member(options, "user")
        var verification = PasskeyUserVerification.preferred
        if let rawSelection = present(options, "authenticatorSelection") {
            guard let selection = rawSelection as? [String: Any] else {
                throw PasskeyFailure.failed
            }
            verification = try userVerification(selection)
        }
        return PasskeyCreationRequest(
            challenge: try binary(options, "challenge"),
            userID: try binary(user, "id"),
            userName: try text(user, "name"),
            userVerification: verification,
            excludedCredentialIDs: try credentialIDs(options, "excludeCredentials")
        )
    }

    /// Reads the WebAuthn JSON form of the request `publicKey` options.
    static func assertionRequest(optionsJson: String) throws -> PasskeyAssertionRequest {
        let options = try topLevelObject(optionsJson)
        try requireSignInRelyingParty(options, "rpId")
        return PasskeyAssertionRequest(
            challenge: try binary(options, "challenge"),
            userVerification: try userVerification(options),
            allowedCredentialIDs: try credentialIDs(options, "allowCredentials")
        )
    }

    // MARK: credential out

    /// The registration response as WebAuthn JSON.
    static func registrationJSON(
        credentialID: Data,
        clientDataJSON: Data,
        attestationObject: Data
    ) throws -> String {
        guard !clientDataJSON.isEmpty, !attestationObject.isEmpty else {
            throw PasskeyFailure.failed
        }
        return try credentialJSON(credentialID: credentialID, response: [
            "clientDataJSON": base64urlEncode(clientDataJSON),
            "attestationObject": base64urlEncode(attestationObject),
            // CLIENT-CLAIMED: a constant written here, not something the
            // system reported. The server ignores it.
            "transports": ["internal", "hybrid"],
        ])
    }

    /// The assertion response as WebAuthn JSON. `userHandle` is left out
    /// when the system gave none, as `PublicKeyCredential.toJSON()` does.
    static func assertionJSON(
        credentialID: Data,
        clientDataJSON: Data,
        authenticatorData: Data,
        signature: Data,
        userHandle: Data?
    ) throws -> String {
        guard !clientDataJSON.isEmpty, !authenticatorData.isEmpty, !signature.isEmpty else {
            throw PasskeyFailure.failed
        }
        var response: [String: Any] = [
            "clientDataJSON": base64urlEncode(clientDataJSON),
            "authenticatorData": base64urlEncode(authenticatorData),
            "signature": base64urlEncode(signature),
        ]
        if let handle = userHandle, !handle.isEmpty {
            response["userHandle"] = base64urlEncode(handle)
        }
        return try credentialJSON(credentialID: credentialID, response: response)
    }

    // MARK: errors

    /// True when one of the system's error texts says the app is not
    /// associated with the relying party's domain (a missing or stale
    /// association file, or a missing entitlement). The texts are only
    /// matched here; they are never sent to the page.
    static func isDomainAssociationFailure(_ texts: [String]) -> Bool {
        texts.contains { $0.contains("not associated with domain") }
    }

    // MARK: private

    /// The one place a credential object is written. `clientExtensionResults`
    /// is the empty object, always (R1).
    private static func credentialJSON(credentialID: Data, response: [String: Any]) throws -> String {
        guard !credentialID.isEmpty else {
            throw PasskeyFailure.failed
        }
        let id = base64urlEncode(credentialID)
        let credential: [String: Any] = [
            "id": id,
            "rawId": id,
            "type": "public-key",
            // CLIENT-CLAIMED: a constant written here, not something the
            // system reported. The server ignores it.
            "authenticatorAttachment": "platform",
            "response": response,
            "clientExtensionResults": [String: Any](),
        ]
        guard JSONSerialization.isValidJSONObject(credential),
              let data = try? JSONSerialization.data(withJSONObject: credential, options: [.sortedKeys])
        else {
            throw PasskeyFailure.failed
        }
        return String(decoding: data, as: UTF8.self)
    }

    private static func topLevelObject(_ optionsJson: String) throws -> [String: Any] {
        guard optionsJson.utf8.count <= maxOptionsBytes,
              let parsed = try? JSONSerialization.jsonObject(with: Data(optionsJson.utf8)),
              let object = parsed as? [String: Any]
        else {
            throw PasskeyFailure.failed
        }
        return object
    }

    /// The member under `key`; nil when it is absent or JSON null.
    private static func present(_ object: [String: Any], _ key: String) -> Any? {
        guard let found = object[key], !(found is NSNull) else {
            return nil
        }
        return found
    }

    /// A required object member.
    private static func member(_ object: [String: Any], _ key: String) throws -> [String: Any] {
        guard let found = present(object, key) as? [String: Any] else {
            throw PasskeyFailure.failed
        }
        return found
    }

    /// A required string member. A number or boolean is refused, not coerced.
    private static func text(_ object: [String: Any], _ key: String) throws -> String {
        guard let found = present(object, key) as? String else {
            throw PasskeyFailure.failed
        }
        return found
    }

    /// Refuses unless the member under `key` is a string that is, byte for
    /// byte, `signInRelyingParty`. Absent, null, not a string, another case,
    /// another host, a trailing dot or surrounding space: all refused. The
    /// value is only compared here and never returned.
    private static func requireSignInRelyingParty(_ object: [String: Any], _ key: String) throws {
        let found = try text(object, key)
        guard found.utf8.elementsEqual(signInRelyingParty.utf8) else {
            throw PasskeyFailure.failed
        }
    }

    /// A required, non-empty base64url member.
    private static func binary(_ object: [String: Any], _ key: String) throws -> Data {
        guard let decoded = base64urlDecode(try text(object, key)), !decoded.isEmpty else {
            throw PasskeyFailure.failed
        }
        return decoded
    }

    /// `userVerification` of `object`: WebAuthn's default `preferred` when
    /// absent, and a value outside the three known ones is refused.
    private static func userVerification(_ object: [String: Any]) throws -> PasskeyUserVerification {
        guard let raw = present(object, "userVerification") else {
            return .preferred
        }
        guard let name = raw as? String, let known = PasskeyUserVerification(rawValue: name) else {
            throw PasskeyFailure.failed
        }
        return known
    }

    /// The ids of a credential descriptor list (`excludeCredentials`,
    /// `allowCredentials`): empty when the list is absent. A descriptor of
    /// another `type` is skipped, as WebAuthn says; one with a bad id is
    /// refused.
    private static func credentialIDs(_ object: [String: Any], _ key: String) throws -> [Data] {
        guard let raw = present(object, key) else {
            return []
        }
        guard let descriptors = raw as? [Any] else {
            throw PasskeyFailure.failed
        }
        var ids: [Data] = []
        for entry in descriptors {
            guard let descriptor = entry as? [String: Any] else {
                throw PasskeyFailure.failed
            }
            if let rawKind = present(descriptor, "type") {
                guard let kind = rawKind as? String else {
                    throw PasskeyFailure.failed
                }
                if kind != "public-key" {
                    continue
                }
            }
            ids.append(try binary(descriptor, "id"))
        }
        return ids
    }
}
