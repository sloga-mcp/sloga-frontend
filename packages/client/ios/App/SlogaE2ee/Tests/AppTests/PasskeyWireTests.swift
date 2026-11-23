// PasskeyWireTests (passkeys plan, Step 1 "Phones", rule R1): the JSON half
// of the `Passkey` plugin and the plugin's bridge surface.
//
// What is pinned, and why it matters:
//   - R1, input: options that carry `extensions.prf` produce exactly the
//     request description the same options produce without it, and the
//     descriptions have no field that could carry an extension. A sign-in
//     passkey that evaluated the PRF would hand a secret to any page allowed
//     to use the passkey's RP ID.
//   - R1, output: every credential the plugin writes has an EMPTY
//     `clientExtensionResults`, whatever the inputs.
//   - The relying party: options are read only when their relying party is,
//     byte for byte, `PasskeyWire.signInRelyingParty`; every other shape
//     (absent, not a string, another case, another host, a trailing dot) is
//     refused, and the descriptions have no field that could carry one. The
//     page drives this plugin, so it must not be able to name a relying
//     party: a passkey kept under another one has to stay out of its reach.
//   - base64url without padding, both ways, and strict on the way in.
//   - Malformed options throw `failed`, the code the page sees, and nothing
//     more specific.
//   - The plugin surface Capacitor resolves (JS name, three methods,
//     selectors), and that bad options are refused on the bridge queue,
//     before any hand-off: no passkey sheet can come up from them.
//
// No test here starts a real ceremony: `create` and `get` are only ever sent
// options the plugin must refuse, so the system sheet never appears.
//
// Known-bad control: set `passkeyControl` to true. Every pinned expectation
// then switches to a deliberately wrong twin, and every test in this class
// that uses `pin` must fail.
import Capacitor
import UIKit
import XCTest
@testable import SlogaE2ee

/// false in the checked-in file. The control run uses a copy with true.
private let passkeyControl = false

/// `real`, or its deliberately wrong twin in the control run.
private func pin<T>(_ real: T, wrong: T) -> T {
    passkeyControl ? wrong : real
}

// MARK: - Fixtures (hand-typed WebAuthn JSON, as the server sends it)

/// 32 bytes 0x00...0x1f, unpadded base64url.
private let challengeText = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8"
private let challengeBytes = Data((0..<32).map { UInt8($0) })
/// The bytes fb ff fe: every character of its encoding differs between the
/// URL-safe and the standard alphabet.
private let userIdText = "-__-"
private let userIdBytes = Data([0xFB, 0xFF, 0xFE])
private let credentialText = "AQIDBA"
private let credentialBytes = Data([1, 2, 3, 4])

private let creationOptions = """
{
  "rp": { "id": "app.sloga.gg", "name": "Sloga" },
  "user": { "id": "\(userIdText)", "name": "ana", "displayName": "Ana" },
  "challenge": "\(challengeText)",
  "pubKeyCredParams": [{ "type": "public-key", "alg": -7 }],
  "excludeCredentials": [{ "type": "public-key", "id": "\(credentialText)" }],
  "authenticatorSelection": { "residentKey": "required", "userVerification": "required" }
}
"""

/// `creationOptions` plus the member R1 says must never be acted on.
private let creationOptionsWithPrf = """
{
  "rp": { "id": "app.sloga.gg", "name": "Sloga" },
  "user": { "id": "\(userIdText)", "name": "ana", "displayName": "Ana" },
  "challenge": "\(challengeText)",
  "pubKeyCredParams": [{ "type": "public-key", "alg": -7 }],
  "excludeCredentials": [{ "type": "public-key", "id": "\(credentialText)" }],
  "authenticatorSelection": { "residentKey": "required", "userVerification": "required" },
  "extensions": { "prf": { "eval": { "first": "\(challengeText)" } }, "largeBlob": { "support": "required" } }
}
"""

private let assertionOptions = """
{
  "rpId": "app.sloga.gg",
  "challenge": "\(challengeText)",
  "userVerification": "required",
  "allowCredentials": [{ "type": "public-key", "id": "\(credentialText)" }]
}
"""

private let assertionOptionsWithPrf = """
{
  "rpId": "app.sloga.gg",
  "challenge": "\(challengeText)",
  "userVerification": "required",
  "allowCredentials": [{ "type": "public-key", "id": "\(credentialText)" }],
  "extensions": { "prf": { "eval": { "first": "\(challengeText)" } } }
}
"""

private let discoverableOptions = """
{ "rpId": "app.sloga.gg", "challenge": "\(challengeText)", "userVerification": "required" }
"""

private func parsedObject(_ json: String) -> [String: Any]? {
    guard let parsed = try? JSONSerialization.jsonObject(with: Data(json.utf8)) else {
        return nil
    }
    return parsed as? [String: Any]
}

private func fieldNames(_ subject: Any) -> [String] {
    Mirror(reflecting: subject).children.compactMap { $0.label }
}

// MARK: - Bridge probes (the CommandTableTests pattern)

private struct PasskeyRejection {
    let message: String
    let code: String?
}

private struct PasskeyOutcome {
    var resolves: [[String: Any]] = []
    var rejects: [PasskeyRejection] = []

    var count: Int {
        resolves.count + rejects.count
    }
}

private final class PasskeyProbe: @unchecked Sendable {
    private let lock = NSLock()
    private var outcome = PasskeyOutcome()
    let settled: XCTestExpectation

    init(_ settled: XCTestExpectation) {
        // A second settle is counted and asserted on, not trapped.
        settled.assertForOverFulfill = false
        self.settled = settled
    }

    func resolved(_ data: [String: Any]?) {
        lock.lock()
        outcome.resolves.append(data ?? [:])
        lock.unlock()
        settled.fulfill()
    }

    func rejected(_ error: CAPPluginCallError?) {
        lock.lock()
        outcome.rejects.append(PasskeyRejection(message: error?.message ?? "<nil error>", code: error?.code))
        lock.unlock()
        settled.fulfill()
    }

    var snapshot: PasskeyOutcome {
        lock.lock()
        defer { lock.unlock() }
        return outcome
    }
}

private struct PasskeyHandoff<Value>: @unchecked Sendable {
    let value: Value
}

private final class PasskeyFlag: @unchecked Sendable {
    private let lock = NSLock()
    private var stored = false

    var isSet: Bool {
        lock.lock()
        defer { lock.unlock() }
        return stored
    }

    func set(_ value: Bool) {
        lock.lock()
        stored = value
        lock.unlock()
    }
}

final class PasskeyWireTests: XCTestCase {
    private let bridgeQueue = DispatchQueue(label: "passkey.bridge")

    // MARK: base64url

    func testBase64urlRoundTripsWithoutPadding() {
        for length in 0...48 {
            let bytes = Data((0..<length).map { UInt8(($0 * 37 + length * 11) & 0xFF) })
            let text = PasskeyWire.base64urlEncode(bytes)
            XCTAssertFalse(text.contains("="), "length \(length): padded")
            XCTAssertFalse(text.contains("+") || text.contains("/"), "length \(length): standard alphabet")
            XCTAssertEqual(PasskeyWire.base64urlDecode(text), bytes, "length \(length)")
        }
        XCTAssertEqual(PasskeyWire.base64urlEncode(userIdBytes), pin(userIdText, wrong: "+//+"))
        XCTAssertEqual(PasskeyWire.base64urlDecode(userIdText), userIdBytes)
        XCTAssertEqual(PasskeyWire.base64urlEncode(credentialBytes), pin(credentialText, wrong: "AQIDBA=="))
        XCTAssertEqual(PasskeyWire.base64urlDecode(challengeText), challengeBytes)
        XCTAssertEqual(PasskeyWire.base64urlDecode(""), Data())
    }

    func testBase64urlDecodeRefusesAnythingButUnpaddedBase64url() {
        let refused = [
            "AQIDBA==",  // padded
            "+//+",  // the standard alphabet
            "A",  // an impossible length
            "AQID BA",  // whitespace
            "AQIDBA\n",
            "AQ.DBA",
            "AQIDB\u{00E9}",
        ]
        for text in refused {
            XCTAssertEqual(PasskeyWire.base64urlDecode(text) == nil, pin(true, wrong: false), "\"\(text)\"")
        }
    }

    // MARK: options in

    func testCreationOptionsAreRead() throws {
        let request = try PasskeyWire.creationRequest(optionsJson: creationOptions)
        XCTAssertEqual(request.challenge, challengeBytes)
        XCTAssertEqual(request.userID, userIdBytes)
        XCTAssertEqual(request.userName, pin("ana", wrong: "Ana"))
        XCTAssertEqual(request.userVerification, .required)
        XCTAssertEqual(request.excludedCredentialIDs, [credentialBytes])
    }

    func testCreationDefaultsWhenOptionalMembersAreAbsent() throws {
        let json = """
        { "rp": { "id": "app.sloga.gg" }, "user": { "id": "\(userIdText)", "name": "ana" }, "challenge": "\(challengeText)" }
        """
        let request = try PasskeyWire.creationRequest(optionsJson: json)
        XCTAssertEqual(request.userVerification, pin(PasskeyUserVerification.preferred, wrong: PasskeyUserVerification.required))
        XCTAssertEqual(request.excludedCredentialIDs, [])
    }

    func testAssertionOptionsAreRead() throws {
        let request = try PasskeyWire.assertionRequest(optionsJson: assertionOptions)
        XCTAssertEqual(request.challenge, challengeBytes)
        XCTAssertEqual(request.userVerification, .required)
        XCTAssertEqual(request.allowedCredentialIDs, pin([credentialBytes], wrong: [Data]()))
    }

    func testAssertionWithoutAllowCredentialsIsDiscoverable() throws {
        let absent = try PasskeyWire.assertionRequest(optionsJson: discoverableOptions)
        XCTAssertEqual(absent.allowedCredentialIDs, pin([Data](), wrong: [credentialBytes]))
        let empty = """
        { "rpId": "app.sloga.gg", "challenge": "\(challengeText)", "allowCredentials": [] }
        """
        XCTAssertEqual(try PasskeyWire.assertionRequest(optionsJson: empty).allowedCredentialIDs, [])
        let null = """
        { "rpId": "app.sloga.gg", "challenge": "\(challengeText)", "allowCredentials": null }
        """
        XCTAssertEqual(try PasskeyWire.assertionRequest(optionsJson: null).allowedCredentialIDs, [])
    }

    func testDescriptorOfAnotherTypeIsSkipped() throws {
        let json = """
        { "rpId": "app.sloga.gg", "challenge": "\(challengeText)",
          "allowCredentials": [{ "type": "other", "id": "!!" }, { "type": "public-key", "id": "\(credentialText)" }] }
        """
        XCTAssertEqual(try PasskeyWire.assertionRequest(optionsJson: json).allowedCredentialIDs, [credentialBytes])
    }

    // MARK: R1, input

    func testExtensionsInTheOptionsChangeNothing() throws {
        let plainCreation = try PasskeyWire.creationRequest(optionsJson: creationOptions)
        let prfCreation = try PasskeyWire.creationRequest(optionsJson: creationOptionsWithPrf)
        XCTAssertEqual(prfCreation, plainCreation)

        let plainAssertion = try PasskeyWire.assertionRequest(optionsJson: assertionOptions)
        let prfAssertion = try PasskeyWire.assertionRequest(optionsJson: assertionOptionsWithPrf)
        XCTAssertEqual(prfAssertion, plainAssertion)

        // The control fixtures really do carry the member.
        XCTAssertNotNil(parsedObject(creationOptionsWithPrf)?["extensions"])
        XCTAssertNotNil(parsedObject(assertionOptionsWithPrf)?["extensions"])
    }

    /// The descriptions are what the plugin builds the system request from.
    /// Their field lists are pinned: a field for extensions, or one for a
    /// relying party read from the options, cannot be added without
    /// changing this test.
    func testRequestDescriptionsHaveNoFieldForExtensions() throws {
        let creation = try PasskeyWire.creationRequest(optionsJson: creationOptionsWithPrf)
        XCTAssertEqual(
            fieldNames(creation),
            pin(
                ["challenge", "userID", "userName", "userVerification", "excludedCredentialIDs"],
                wrong: ["relyingParty", "challenge", "userID", "userName", "userVerification", "excludedCredentialIDs"]
            )
        )
        let assertion = try PasskeyWire.assertionRequest(optionsJson: assertionOptionsWithPrf)
        XCTAssertEqual(
            fieldNames(assertion),
            pin(
                ["challenge", "userVerification", "allowedCredentialIDs"],
                wrong: ["challenge", "userVerification", "allowedCredentialIDs", "extensions"]
            )
        )
        for name in fieldNames(creation) + fieldNames(assertion) {
            XCTAssertFalse(name.lowercased().contains("extension"), name)
            XCTAssertFalse(name.lowercased().contains("prf"), name)
            XCTAssertFalse(name.lowercased().contains("relying"), name)
        }
    }

    // MARK: the relying party is pinned

    func testSignInRelyingPartyIsTheAssociatedDomain() {
        // The host of the `webcredentials:` entry in both entitlements files
        // (scripts/check-ios-e2ee-commands.mjs compares the three).
        XCTAssertEqual(PasskeyWire.signInRelyingParty, pin("app.sloga.gg", wrong: "sloga.gg"))
    }

    /// JSON text for each relying party value the readers must refuse. The
    /// text goes into the options verbatim, so `7` is a number and
    /// `"sloga.gg"` a string.
    private static let refusedRelyingParties: [(String, String)] = [
        ("a number", "7"),
        ("a boolean", "true"),
        ("null", "null"),
        ("an array holding the right host", "[\"app.sloga.gg\"]"),
        ("an object holding the right host", "{ \"id\": \"app.sloga.gg\" }"),
        ("empty", "\"\""),
        ("upper case", "\"APP.SLOGA.GG\""),
        ("mixed case", "\"App.Sloga.gg\""),
        ("the parent domain", "\"sloga.gg\""),
        ("a sibling host", "\"backup.sloga.gg\""),
        ("a deeper host", "\"x.app.sloga.gg\""),
        ("another site", "\"example.com\""),
        ("the right host as a prefix", "\"app.sloga.gg.example.com\""),
        ("the right host as a suffix", "\"xapp.sloga.gg\""),
        ("a trailing dot", "\"app.sloga.gg.\""),
        ("a leading space", "\" app.sloga.gg\""),
        ("a trailing space", "\"app.sloga.gg \""),
        ("a trailing newline", "\"app.sloga.gg\\n\""),
        ("a trailing NUL", "\"app.sloga.gg\\u0000\""),
        ("a scheme", "\"https://app.sloga.gg\""),
        ("a port", "\"app.sloga.gg:443\""),
        ("a look-alike letter", "\"\\u0430pp.sloga.gg\""),
    ]

    func testCreationRefusesEveryRelyingPartyButTheSignInOne() throws {
        let user = "\"user\": { \"id\": \"\(userIdText)\", \"name\": \"ana\" }"
        let challenge = "\"challenge\": \"\(challengeText)\""
        for (label, value) in Self.refusedRelyingParties {
            let json = "{ \"rp\": { \"id\": \(value), \"name\": \"Sloga\" }, \(user), \(challenge) }"
            // The fixture is well-formed JSON: it is refused for its value.
            XCTAssertNotNil(parsedObject(json), "rp.id \(label): the fixture is not JSON")
            assertFailed({ _ = try PasskeyWire.creationRequest(optionsJson: json) }, "rp.id \(label)")
        }
        // `rp.name` is not the relying party, and neither is a top-level `rpId`.
        assertFailed({
            _ = try PasskeyWire.creationRequest(
                optionsJson: "{ \"rp\": { \"name\": \"app.sloga.gg\" }, \"rpId\": \"app.sloga.gg\", \(user), \(challenge) }"
            )
        }, "rp.id absent")
        // The accepted shape: exactly the constant.
        let accepted = "{ \"rp\": { \"id\": \"\(PasskeyWire.signInRelyingParty)\" }, \(user), \(challenge) }"
        XCTAssertEqual(try PasskeyWire.creationRequest(optionsJson: accepted).challenge, challengeBytes)
    }

    func testAssertionRefusesEveryRelyingPartyButTheSignInOne() throws {
        let challenge = "\"challenge\": \"\(challengeText)\""
        for (label, value) in Self.refusedRelyingParties {
            let json = "{ \"rpId\": \(value), \(challenge) }"
            XCTAssertNotNil(parsedObject(json), "rpId \(label): the fixture is not JSON")
            assertFailed({ _ = try PasskeyWire.assertionRequest(optionsJson: json) }, "rpId \(label)")
        }
        // A creation-style `rp.id` is not read by `get`.
        assertFailed({
            _ = try PasskeyWire.assertionRequest(optionsJson: "{ \"rp\": { \"id\": \"app.sloga.gg\" }, \(challenge) }")
        }, "rpId absent")
        let accepted = "{ \"rpId\": \"\(PasskeyWire.signInRelyingParty)\", \(challenge) }"
        XCTAssertEqual(try PasskeyWire.assertionRequest(optionsJson: accepted).challenge, challengeBytes)
    }

    // MARK: malformed options

    private func assertFailed(
        _ body: () throws -> Void,
        _ context: String,
        file: StaticString = #filePath,
        line: UInt = #line
    ) {
        do {
            try body()
            XCTFail("\(context): accepted", file: file, line: line)
        } catch let failure as PasskeyFailure {
            XCTAssertEqual(failure, pin(PasskeyFailure.failed, wrong: PasskeyFailure.unavailable), context, file: file, line: line)
            XCTAssertEqual(failure.rawValue, pin("failed", wrong: "invalid_argument"), context, file: file, line: line)
        } catch {
            XCTFail("\(context): threw something other than PasskeyFailure", file: file, line: line)
        }
    }

    func testMalformedCreationOptionsFail() {
        let user = "\"user\": { \"id\": \"\(userIdText)\", \"name\": \"ana\" }"
        let rp = "\"rp\": { \"id\": \"app.sloga.gg\" }"
        let challenge = "\"challenge\": \"\(challengeText)\""
        let cases: [(String, String)] = [
            ("not JSON", "{"),
            ("empty", ""),
            ("a top-level array", "[]"),
            ("a top-level string", "\"x\""),
            ("no challenge", "{ \(rp), \(user) }"),
            ("a padded challenge", "{ \(rp), \(user), \"challenge\": \"AQIDBA==\" }"),
            ("a standard-alphabet challenge", "{ \(rp), \(user), \"challenge\": \"+//+\" }"),
            ("an empty challenge", "{ \(rp), \(user), \"challenge\": \"\" }"),
            ("a numeric challenge", "{ \(rp), \(user), \"challenge\": 5 }"),
            ("no rp", "{ \(user), \(challenge) }"),
            ("rp as a string", "{ \"rp\": \"app.sloga.gg\", \(user), \(challenge) }"),
            ("no rp.id", "{ \"rp\": { \"name\": \"Sloga\" }, \(user), \(challenge) }"),
            ("an empty rp.id", "{ \"rp\": { \"id\": \"\" }, \(user), \(challenge) }"),
            ("a numeric rp.id", "{ \"rp\": { \"id\": 7 }, \(user), \(challenge) }"),
            ("no user", "{ \(rp), \(challenge) }"),
            ("no user.id", "{ \(rp), \"user\": { \"name\": \"ana\" }, \(challenge) }"),
            ("no user.name", "{ \(rp), \"user\": { \"id\": \"\(userIdText)\" }, \(challenge) }"),
            ("a boolean user.name", "{ \(rp), \"user\": { \"id\": \"\(userIdText)\", \"name\": true }, \(challenge) }"),
            ("an unknown userVerification",
             "{ \(rp), \(user), \(challenge), \"authenticatorSelection\": { \"userVerification\": \"maybe\" } }"),
            ("authenticatorSelection as a string", "{ \(rp), \(user), \(challenge), \"authenticatorSelection\": \"x\" }"),
            ("excludeCredentials as an object", "{ \(rp), \(user), \(challenge), \"excludeCredentials\": {} }"),
            ("a descriptor without an id", "{ \(rp), \(user), \(challenge), \"excludeCredentials\": [{ \"type\": \"public-key\" }] }"),
            ("a descriptor with a bad id",
             "{ \(rp), \(user), \(challenge), \"excludeCredentials\": [{ \"type\": \"public-key\", \"id\": \"AQIDBA==\" }] }"),
            ("a descriptor that is a string", "{ \(rp), \(user), \(challenge), \"excludeCredentials\": [\"AQIDBA\"] }"),
        ]
        for (label, json) in cases {
            assertFailed({ _ = try PasskeyWire.creationRequest(optionsJson: json) }, label)
        }
    }

    func testMalformedAssertionOptionsFail() {
        let challenge = "\"challenge\": \"\(challengeText)\""
        let cases: [(String, String)] = [
            ("not JSON", "nope"),
            ("no rpId", "{ \(challenge) }"),
            ("an empty rpId", "{ \"rpId\": \"\", \(challenge) }"),
            ("no challenge", "{ \"rpId\": \"app.sloga.gg\" }"),
            ("a padded challenge", "{ \"rpId\": \"app.sloga.gg\", \"challenge\": \"AQIDBA==\" }"),
            ("an unknown userVerification", "{ \"rpId\": \"app.sloga.gg\", \(challenge), \"userVerification\": 1 }"),
            ("allowCredentials as a string", "{ \"rpId\": \"app.sloga.gg\", \(challenge), \"allowCredentials\": \"AQIDBA\" }"),
            ("a descriptor with a bad id",
             "{ \"rpId\": \"app.sloga.gg\", \(challenge), \"allowCredentials\": [{ \"id\": \"!!\" }] }"),
        ]
        for (label, json) in cases {
            assertFailed({ _ = try PasskeyWire.assertionRequest(optionsJson: json) }, label)
        }
    }

    func testOversizedOptionsFailUnparsed() {
        let filler = String(repeating: "a", count: PasskeyWire.maxOptionsBytes)
        let json = "{ \"rpId\": \"app.sloga.gg\", \"challenge\": \"\(challengeText)\", \"pad\": \"\(filler)\" }"
        assertFailed({ _ = try PasskeyWire.assertionRequest(optionsJson: json) }, "oversized")
    }

    // MARK: credential out (R1, output)

    func testRegistrationJSONShape() throws {
        let json = try PasskeyWire.registrationJSON(
            credentialID: userIdBytes,
            clientDataJSON: Data([0xFB, 0xFF]),
            attestationObject: Data([0xFF, 0xFE, 0xFD, 0xFC])
        )
        XCTAssertFalse(json.contains("="), "padding in the output")
        let credential = try XCTUnwrap(parsedObject(json))
        XCTAssertEqual(
            Set(credential.keys),
            pin(Set(["id", "rawId", "type", "authenticatorAttachment", "response", "clientExtensionResults"]),
                wrong: Set(["id", "rawId", "type", "authenticatorAttachment", "response"]))
        )
        XCTAssertEqual(credential["id"] as? String, userIdText)
        XCTAssertEqual(credential["rawId"] as? String, userIdText)
        XCTAssertEqual(credential["type"] as? String, "public-key")
        XCTAssertEqual(credential["authenticatorAttachment"] as? String, "platform")
        let results = try XCTUnwrap(credential["clientExtensionResults"] as? [String: Any])
        XCTAssertEqual(results.count, pin(0, wrong: 1), "clientExtensionResults must be empty (R1)")
        let response = try XCTUnwrap(credential["response"] as? [String: Any])
        XCTAssertEqual(Set(response.keys), ["clientDataJSON", "attestationObject", "transports"])
        XCTAssertEqual(response["clientDataJSON"] as? String, "-_8")
        XCTAssertEqual(response["attestationObject"] as? String, "__79_A")
        XCTAssertEqual(response["transports"] as? [String], pin(["internal", "hybrid"], wrong: ["internal"]))
    }

    func testAssertionJSONShape() throws {
        let json = try PasskeyWire.assertionJSON(
            credentialID: credentialBytes,
            clientDataJSON: Data([0xFB, 0xFF]),
            authenticatorData: Data([0xFF, 0xFE, 0xFD, 0xFC]),
            signature: Data([0x30, 0x06]),
            userHandle: userIdBytes
        )
        XCTAssertFalse(json.contains("="), "padding in the output")
        let credential = try XCTUnwrap(parsedObject(json))
        XCTAssertEqual(
            Set(credential.keys),
            ["id", "rawId", "type", "authenticatorAttachment", "response", "clientExtensionResults"]
        )
        XCTAssertEqual(credential["id"] as? String, credentialText)
        XCTAssertEqual(credential["rawId"] as? String, credentialText)
        XCTAssertEqual(credential["type"] as? String, "public-key")
        XCTAssertEqual(credential["authenticatorAttachment"] as? String, "platform")
        let results = try XCTUnwrap(credential["clientExtensionResults"] as? [String: Any])
        XCTAssertEqual(results.count, pin(0, wrong: 1), "clientExtensionResults must be empty (R1)")
        let response = try XCTUnwrap(credential["response"] as? [String: Any])
        XCTAssertEqual(
            Set(response.keys),
            pin(Set(["clientDataJSON", "authenticatorData", "signature", "userHandle"]),
                wrong: Set(["clientDataJSON", "authenticatorData", "signature"]))
        )
        XCTAssertEqual(response["authenticatorData"] as? String, "__79_A")
        XCTAssertEqual(response["signature"] as? String, "MAY")
        XCTAssertEqual(response["userHandle"] as? String, userIdText)
    }

    func testAssertionJSONLeavesOutAnAbsentUserHandle() throws {
        for handle in [nil, Data()] as [Data?] {
            let json = try PasskeyWire.assertionJSON(
                credentialID: credentialBytes,
                clientDataJSON: Data([1]),
                authenticatorData: Data([2]),
                signature: Data([3]),
                userHandle: handle
            )
            let response = try XCTUnwrap(parsedObject(json)?["response"] as? [String: Any])
            XCTAssertEqual(Set(response.keys), ["clientDataJSON", "authenticatorData", "signature"])
        }
    }

    func testEmptyCredentialPartsFail() {
        assertFailed({
            _ = try PasskeyWire.registrationJSON(credentialID: Data(), clientDataJSON: Data([1]), attestationObject: Data([2]))
        }, "an empty credential id")
        assertFailed({
            _ = try PasskeyWire.registrationJSON(credentialID: Data([1]), clientDataJSON: Data(), attestationObject: Data([2]))
        }, "empty client data")
        assertFailed({
            _ = try PasskeyWire.registrationJSON(credentialID: Data([1]), clientDataJSON: Data([1]), attestationObject: Data())
        }, "an empty attestation")
        assertFailed({
            _ = try PasskeyWire.assertionJSON(
                credentialID: Data([1]), clientDataJSON: Data([1]), authenticatorData: Data([1]), signature: Data(), userHandle: nil
            )
        }, "an empty signature")
    }

    // MARK: codes

    func testRejectCodesAreTheContractStrings() {
        XCTAssertEqual(PasskeyFailure.cancelled.rawValue, pin("cancelled", wrong: "canceled"))
        XCTAssertEqual(PasskeyFailure.noCredential.rawValue, pin("no_credential", wrong: "noCredential"))
        XCTAssertEqual(PasskeyFailure.unavailable.rawValue, "unavailable")
        XCTAssertEqual(PasskeyFailure.failed.rawValue, "failed")
    }

    func testDomainAssociationFailureIsRecognizedFromTheSystemText() {
        XCTAssertEqual(
            PasskeyWire.isDomainAssociationFailure(
                ["", "Application with identifier M6UUDLK2XQ.gg.sloga.app is not associated with domain app.sloga.gg"]
            ),
            pin(true, wrong: false)
        )
        XCTAssertFalse(PasskeyWire.isDomainAssociationFailure(["The operation couldn't be completed.", ""]))
        XCTAssertFalse(PasskeyWire.isDomainAssociationFailure([]))
    }

    // MARK: plugin surface

    func testPluginIdentity() {
        let plugin = PasskeyPlugin()
        XCTAssertEqual(plugin.jsName, pin("Passkey", wrong: "PasskeyPlugin"))
        XCTAssertEqual(plugin.identifier, "PasskeyPlugin")
        XCTAssertEqual(NSStringFromClass(PasskeyPlugin.self), "PasskeyPlugin")
    }

    func testPluginMethodsAreTheThreeContractPromises() {
        let plugin = PasskeyPlugin()
        let names = plugin.pluginMethods.map { $0.name ?? "" }
        XCTAssertEqual(names, pin(["isAvailable", "create", "get"], wrong: ["isAvailable", "create"]))
        for method in plugin.pluginMethods {
            let name = method.name ?? ""
            XCTAssertEqual(method.returnType ?? "", CAPPluginReturnPromise, name)
            let selector = NSSelectorFromString(name + ":")
            XCTAssertEqual(method.selector, selector, name)
            XCTAssertTrue(plugin.responds(to: selector), name)
        }
    }

    func testRunningAppRegistersPasskeyBehindTheGuard() {
        let found: (className: String?, guardInstalled: Bool)? = MainActor.assumeIsolated {
            let controllers = UIApplication.shared.connectedScenes
                .compactMap { $0 as? UIWindowScene }
                .flatMap { $0.windows }
                .compactMap { $0.rootViewController as? SlogaBridgeViewController }
            guard let controller = controllers.first, let bridge = controller.bridge else {
                return nil
            }
            let plugin = bridge.plugin(withName: "Passkey")
            return (plugin.map { NSStringFromClass(type(of: $0)) }, controller.bridgeGuard != nil)
        }
        guard let found = found else {
            XCTFail("no SlogaBridgeViewController with a bridge in any window")
            return
        }
        XCTAssertEqual(found.className, pin("PasskeyPlugin", wrong: nil))
        XCTAssertTrue(found.guardInstalled, "the plugin may only be registered behind the main-frame guard")
    }

    // MARK: behaviour through a real CAPPluginCall

    func testIsAvailableResolvesAndNeverRejects() {
        // The app under test armed the plugin when it installed the guard
        // (testRunningAppRegistersPasskeyBehindTheGuard), and the flag is
        // process-wide.
        var expected = false
        if #available(iOS 16.0, *) {
            expected = true
        }
        let result = invoke("isAvailable", [:])
        XCTAssertEqual(result.outcome.rejects.count, 0)
        XCTAssertEqual(result.outcome.count, 1, "settles exactly once")
        XCTAssertEqual(result.outcome.resolves.first?["available"] as? Bool, pin(expected, wrong: !expected))
        XCTAssertEqual(result.outcome.resolves.first?.count, 1)
    }

    func testBadOptionsAreRefusedBeforeAnyHandOff() {
        var expected = "unavailable"
        if #available(iOS 16.0, *) {
            expected = "failed"
        }
        let cases: [[String: Any]] = [
            [:],
            ["optionsJson": NSNull()],
            ["optionsJson": 5],
            ["optionsJson": ["rpId": "app.sloga.gg"]],
            ["optionsJson": "{"],
            ["optionsJson": "{ \"rpId\": \"app.sloga.gg\" }"],
            // The page's key is `optionsJson`; nothing else is read.
            ["options": assertionOptions],
            // Well-formed options for another relying party are refused the
            // same way: no sheet can come up for one.
            ["optionsJson": assertionOptions.replacingOccurrences(of: "app.sloga.gg", with: "backup.sloga.gg")],
            ["optionsJson": creationOptions.replacingOccurrences(of: "app.sloga.gg", with: "backup.sloga.gg")],
        ]
        for method in ["create", "get"] {
            for options in cases {
                let result = invoke(method, options)
                let context = "\(method) \(options)"
                XCTAssertEqual(result.outcome.resolves.count, 0, "\(context): resolved")
                XCTAssertEqual(result.outcome.count, 1, "\(context): settles exactly once")
                XCTAssertTrue(result.settledInline, "\(context): refused on the bridge queue, no sheet")
                XCTAssertEqual(result.outcome.rejects.first?.code, pin(expected, wrong: "cancelled"), context)
                XCTAssertEqual(result.outcome.rejects.first?.message, expected, context)
            }
        }
    }

    // MARK: - Helpers

    private struct Invocation {
        let outcome: PasskeyOutcome
        let settledInline: Bool
    }

    /// Builds the call as Capacitor's handleJSCall does and performs the
    /// selector on a serial queue standing in for Capacitor's.
    private func invoke(_ method: String, _ options: [String: Any], file: StaticString = #filePath, line: UInt = #line) -> Invocation {
        let plugin = PasskeyPlugin()
        let selector = NSSelectorFromString(method + ":")
        guard plugin.responds(to: selector) else {
            // perform() on a missing selector would crash the host, not fail the test.
            XCTFail("plugin has no \(method):", file: file, line: line)
            return Invocation(outcome: PasskeyOutcome(), settledInline: false)
        }

        let probe = PasskeyProbe(expectation(description: "\(method) settles"))
        let jsOptions = JSTypes.coerceDictionaryToJSObject(options as NSDictionary, formattingDatesAsStrings: true) ?? [:]
        let made: CAPPluginCall? = CAPPluginCall(
            callbackId: "passkey-\(UUID().uuidString)",
            methodName: method,
            options: jsOptions,
            success: { result, _ in probe.resolved(result?.data) },
            error: { error in probe.rejected(error) }
        )
        guard let call = made else {
            XCTFail("CAPPluginCall init returned nil", file: file, line: line)
            return Invocation(outcome: PasskeyOutcome(), settledInline: false)
        }

        let inline = PasskeyFlag()
        let handoff = PasskeyHandoff(value: (plugin, call))
        bridgeQueue.async {
            _ = handoff.value.0.perform(selector, with: handoff.value.1)
            inline.set(probe.snapshot.count > 0)
        }
        wait(for: [probe.settled], timeout: 30)
        // The method has returned on the bridge queue.
        bridgeQueue.sync {}
        // A stray second settle from a hand-off would land shortly after.
        let never = XCTestExpectation(description: "idle")
        never.isInverted = true
        _ = XCTWaiter.wait(for: [never], timeout: 0.1)
        return Invocation(outcome: probe.snapshot, settledInline: inline.isSet)
    }
}
