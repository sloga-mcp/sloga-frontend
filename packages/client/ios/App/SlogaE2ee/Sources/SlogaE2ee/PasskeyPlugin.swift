// PasskeyPlugin.swift: the Capacitor plugin `Passkey` (passkeys plan, Step 1
// "Phones"). The webview runs at capacitor://localhost and cannot perform a
// WebAuthn ceremony itself, so the page hands the server's options to this
// plugin, which runs the system passkey sheet and hands back the credential.
// The contract is the Android plugin's:
//   isAvailable()            -> { available }      never rejects
//   create({ optionsJson })  -> { credentialJson } a new passkey
//   get({ optionsJson })     -> { credentialJson } sign in with a passkey
// `optionsJson` and `credentialJson` are WebAuthn JSON (PasskeyWire.swift).
//
// Rejections carry a fixed code (message and code are the same string),
// never the system's error text:
//   cancelled      the user closed the sheet
//   unavailable    below iOS 16, the plugin is not armed, or the app is not
//                  associated with the relying party's domain
//   failed         anything else: malformed options, a second call while a
//                  sheet is open, an unexpected system error
//   no_credential  reserved for Android parity. iOS has no such signal for
//                  a sheet the user can see: when no passkey on the device
//                  matches, the system offers "use another device" and the
//                  user's way out is a cancel.
//
// Rule R1 of the plan: a sign-in passkey never carries a WebAuthn extension,
// the pseudo-random function one above all, even on an iOS that offers it.
// The requests built here are set from a PasskeyCreationRequest or
// PasskeyAssertionRequest, which have no field for one, and the result is
// written by PasskeyWire, which always writes an empty
// `clientExtensionResults`. No extension input is ever set on a request and
// no extension output is ever read from a credential.
// scripts/check-ios-e2ee-commands.mjs pins this (G8d-passkey-extensions).
//
// One relying party. The page drives this plugin, so it serves only the
// sign-in passkey's relying party, `PasskeyWire.signInRelyingParty`.
// PasskeyWire refuses options that name any other, and the system provider
// is built in one place (`PasskeyCeremony.signInProvider`) from that
// constant: no value read from the options ever becomes a relying party
// identifier. A passkey under another relying party cannot be created or
// used from the page through this plugin (G8d-passkey-rp).
//
// iOS 16: the app still deploys to iOS 15, where there are no passkeys.
// Every AuthenticationServices use sits behind `#available(iOS 16.0, *)`;
// below it `isAvailable` answers false and the other two reject
// `unavailable`.
//
// Arming: as for E2eePlugin and SlogaCallAudioPlugin. Capacitor can create
// a plugin by class name for a message naming an unregistered plugin id
// (E2eePlugin.swift explains the path), so every method first checks a flag
// that only SlogaBridgeViewController sets, right after the main-frame
// bridge guard is installed. Unarmed, `isAvailable` answers false and the
// other two reject `unavailable`: a third-party embed frame can never raise
// a passkey sheet over the app.
//
// Threading. Capacitor calls the methods on its bridge queue; they read and
// check the options there and return at once. The sheet is created and run
// on the main thread, and the system calls the delegate back there.
//
// One sheet at a time, process-wide: a `create` or `get` sent while one is
// open rejects `failed` without touching the open one.
//
// A page that is gone cannot use the answer: when the main frame starts a
// new load the bridge view controller calls `cancelAfterPageLoss()` (native
// only, not a plugin method), which closes an open sheet. A ceremony that
// has claimed the slot but not yet raised its sheet is marked instead, and
// then settles `cancelled` without ever showing one.
//
// Nothing here is logged: no options, no credential, no error.
import AuthenticationServices
import Capacitor
import Foundation
import UIKit

@objc(PasskeyPlugin)
public final class PasskeyPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "PasskeyPlugin"
    public let jsName = "Passkey"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "isAvailable", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "create", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "get", returnType: CAPPluginReturnPromise),
    ]

    private static let armLock = NSLock()
    private static var armed = false

    /// Called once by the bridge view controller after the main-frame
    /// bridge guard is in place, before it registers this plugin.
    static func arm() {
        armLock.lock()
        armed = true
        armLock.unlock()
    }

    private static func isArmed() -> Bool {
        armLock.lock()
        let ready = armed
        armLock.unlock()
        return ready
    }

    private static func armedOrRefuse(_ call: CAPPluginCall) -> Bool {
        let ready = isArmed()
        if !ready {
            refuse(call, .unavailable)
        }
        return ready
    }

    /// The one open ceremony. `ceremonyClaimed` goes true on the bridge
    /// queue before the hop to main, so two calls racing there cannot both
    /// open a sheet; `ceremonyHeld` keeps the delegate object alive (the
    /// system holds its delegate weakly). `ceremonyCancelRequested` records
    /// a page loss that arrived after the claim and before the hold, when
    /// there is no sheet to close yet. All three under `ceremonyLock`.
    private static let ceremonyLock = NSLock()
    private static var ceremonyClaimed = false
    private static var ceremonyHeld: AnyObject?
    private static var ceremonyCancelRequested = false

    private static func claimCeremony() -> Bool {
        ceremonyLock.lock()
        defer { ceremonyLock.unlock() }
        if ceremonyClaimed {
            return false
        }
        ceremonyClaimed = true
        ceremonyCancelRequested = false
        return true
    }

    /// Keeps `ceremony` alive as the open one and answers true; or, when
    /// the page was lost since the claim, keeps nothing and answers false:
    /// the caller must then settle the call and free the slot without
    /// showing a sheet.
    private static func holdUnlessCancelled(_ ceremony: AnyObject) -> Bool {
        ceremonyLock.lock()
        defer { ceremonyLock.unlock() }
        if ceremonyCancelRequested {
            return false
        }
        ceremonyHeld = ceremony
        return true
    }

    /// The open ceremony has settled its call (or never started): the next
    /// `create` or `get` may run.
    static func ceremonyEnded() {
        ceremonyLock.lock()
        ceremonyHeld = nil
        ceremonyClaimed = false
        ceremonyCancelRequested = false
        ceremonyLock.unlock()
    }

    static func refuse(_ call: CAPPluginCall, _ failure: PasskeyFailure) {
        // No `error` argument: Capacitor would forward its description.
        call.reject(failure.rawValue, failure.rawValue)
    }

    /// `optionsJson`, or nil when it is missing or not a string.
    private static func optionsText(_ call: CAPPluginCall) -> String? {
        guard let options = call.options, let raw = options["optionsJson"] else {
            return nil
        }
        return raw as? String
    }

    @objc func isAvailable(_ call: CAPPluginCall) {
        var available = false
        if #available(iOS 16.0, *) {
            available = Self.isArmed()
        }
        call.resolve(["available": available])
    }

    @objc func create(_ call: CAPPluginCall) {
        guard Self.armedOrRefuse(call) else { return }
        guard #available(iOS 16.0, *) else {
            Self.refuse(call, .unavailable)
            return
        }
        guard let options = Self.optionsText(call),
              let request = try? PasskeyWire.creationRequest(optionsJson: options)
        else {
            Self.refuse(call, .failed)
            return
        }
        launch(call, .create(request))
    }

    @objc func get(_ call: CAPPluginCall) {
        guard Self.armedOrRefuse(call) else { return }
        guard #available(iOS 16.0, *) else {
            Self.refuse(call, .unavailable)
            return
        }
        guard let options = Self.optionsText(call),
              let request = try? PasskeyWire.assertionRequest(optionsJson: options)
        else {
            Self.refuse(call, .failed)
            return
        }
        launch(call, .get(request))
    }

    /// Native only (not a plugin method): closes an open passkey sheet
    /// after the page that asked for it is gone. Safe from any thread;
    /// returns at once. With a sheet open, the system then reports a
    /// cancel, which settles the (dead) call and frees the slot. With the
    /// slot claimed and no sheet raised yet, the loss is recorded and
    /// `raise` settles the call `cancelled` without showing one. A no-op
    /// when no ceremony is under way.
    static func cancelAfterPageLoss() {
        ceremonyLock.lock()
        let open = ceremonyHeld
        if open == nil, ceremonyClaimed {
            ceremonyCancelRequested = true
        }
        ceremonyLock.unlock()
        guard let ceremony = open else {
            return
        }
        DispatchQueue.main.async {
            if #available(iOS 16.0, *) {
                if let sheet = ceremony as? PasskeyCeremony {
                    MainActor.assumeIsolated {
                        sheet.abandon()
                    }
                }
            }
        }
    }

    /// Claims the one ceremony slot, then raises the sheet on main.
    @available(iOS 16.0, *)
    private func launch(_ call: CAPPluginCall, _ request: PasskeyRequest) {
        guard Self.claimCeremony() else {
            Self.refuse(call, .failed)
            return
        }
        DispatchQueue.main.async {
            MainActor.assumeIsolated {
                self.raise(call, request)
            }
        }
    }

    /// Runs the sheet over the window the webview is in. With no window to
    /// anchor it to, the call rejects `failed` and the slot is freed. When
    /// the page was lost between the claim and here, the call rejects
    /// `cancelled`, the slot is freed and no sheet is shown.
    @available(iOS 16.0, *)
    @MainActor private func raise(_ call: CAPPluginCall, _ request: PasskeyRequest) {
        guard let anchor = bridge?.viewController?.viewIfLoaded?.window ?? Self.frontWindow() else {
            Self.refuse(call, .failed)
            Self.ceremonyEnded()
            return
        }
        let ceremony = PasskeyCeremony(call: call, anchor: anchor, request: request)
        // The check and the hold are one step under the lock: a page loss
        // either marked the slot before it (refused here) or finds the
        // held ceremony after it (closed by `abandon`, queued behind this
        // function on main, so after `run` has made the sheet).
        guard Self.holdUnlessCancelled(ceremony) else {
            Self.refuse(call, .cancelled)
            Self.ceremonyEnded()
            return
        }
        ceremony.run()
    }

    /// The key window, or failing that any window of the app.
    @MainActor private static func frontWindow() -> UIWindow? {
        let windows = UIApplication.shared.connectedScenes
            .compactMap { $0 as? UIWindowScene }
            .flatMap { $0.windows }
        return windows.first(where: { $0.isKeyWindow }) ?? windows.first
    }
}

/// One passkey sheet: builds the system request from the plain description,
/// runs it, and settles the plugin call exactly once with the credential or
/// a fixed code. Created, run and called back on the main thread.
@available(iOS 16.0, *)
final class PasskeyCeremony: NSObject, ASAuthorizationControllerDelegate,
    ASAuthorizationControllerPresentationContextProviding {
    private let call: CAPPluginCall
    private let anchor: UIWindow
    private let request: PasskeyRequest
    private let lock = NSLock()
    private var finished = false
    private var controller: ASAuthorizationController?

    init(call: CAPPluginCall, anchor: UIWindow, request: PasskeyRequest) {
        self.call = call
        self.anchor = anchor
        self.request = request
        super.init()
    }

    @MainActor func run() {
        let systemRequest: ASAuthorizationRequest
        switch request {
        case .create(let creation):
            systemRequest = Self.registrationRequest(creation)
        case .get(let assertion):
            systemRequest = Self.assertionRequest(assertion)
        }
        let sheet = ASAuthorizationController(authorizationRequests: [systemRequest])
        sheet.delegate = self
        sheet.presentationContextProvider = self
        controller = sheet
        sheet.performRequests()
    }

    /// Closes the sheet; the system then calls back with a cancel.
    @MainActor func abandon() {
        controller?.cancel()
    }

    // MARK: requests (R1: nothing but the fields of the description is set)

    /// The ONE place a system credential provider is built, and the one
    /// relying party identifier this file ever names: the constant, taken
    /// directly. It has no parameter, so nothing read from the options can
    /// reach the system as a relying party (G8d-passkey-rp).
    private static func signInProvider() -> ASAuthorizationPlatformPublicKeyCredentialProvider {
        ASAuthorizationPlatformPublicKeyCredentialProvider(relyingPartyIdentifier: PasskeyWire.signInRelyingParty)
    }

    private static func registrationRequest(_ creation: PasskeyCreationRequest) -> ASAuthorizationRequest {
        let provider = signInProvider()
        let registration = provider.createCredentialRegistrationRequest(
            challenge: creation.challenge,
            name: creation.userName,
            userID: creation.userID
        )
        registration.userVerificationPreference = preference(creation.userVerification)
        // Before iOS 17.4 a platform registration has no exclude list, so
        // below it the options' exclude list cannot be honoured.
        if #available(iOS 17.4, *), !creation.excludedCredentialIDs.isEmpty {
            registration.excludedCredentials = creation.excludedCredentialIDs.map {
                ASAuthorizationPlatformPublicKeyCredentialDescriptor(credentialID: $0)
            }
        }
        return registration
    }

    private static func assertionRequest(_ assertion: PasskeyAssertionRequest) -> ASAuthorizationRequest {
        let provider = signInProvider()
        let request = provider.createCredentialAssertionRequest(challenge: assertion.challenge)
        request.userVerificationPreference = preference(assertion.userVerification)
        // Empty stays empty: a discoverable sign-in.
        if !assertion.allowedCredentialIDs.isEmpty {
            request.allowedCredentials = assertion.allowedCredentialIDs.map {
                ASAuthorizationPlatformPublicKeyCredentialDescriptor(credentialID: $0)
            }
        }
        return request
    }

    private static func preference(
        _ verification: PasskeyUserVerification
    ) -> ASAuthorizationPublicKeyCredentialUserVerificationPreference {
        switch verification {
        case .required:
            return .required
        case .preferred:
            return .preferred
        case .discouraged:
            return .discouraged
        }
    }

    // MARK: results

    /// The credential as WebAuthn JSON, or nil when the system returned
    /// something other than what this ceremony asked for.
    private func credentialJson(_ credential: ASAuthorizationCredential) -> String? {
        switch request {
        case .create:
            guard let registration = credential as? ASAuthorizationPlatformPublicKeyCredentialRegistration,
                  let attestation = registration.rawAttestationObject
            else {
                return nil
            }
            return try? PasskeyWire.registrationJSON(
                credentialID: registration.credentialID,
                clientDataJSON: registration.rawClientDataJSON,
                attestationObject: attestation
            )
        case .get:
            guard let assertion = credential as? ASAuthorizationPlatformPublicKeyCredentialAssertion else {
                return nil
            }
            // Read through optionals: the SDK declares these three as
            // implicitly unwrapped.
            let rawAuthenticatorData: Data? = assertion.rawAuthenticatorData
            let rawSignature: Data? = assertion.signature
            let userHandle: Data? = assertion.userID
            guard let authenticatorData = rawAuthenticatorData, let signature = rawSignature else {
                return nil
            }
            return try? PasskeyWire.assertionJSON(
                credentialID: assertion.credentialID,
                clientDataJSON: assertion.rawClientDataJSON,
                authenticatorData: authenticatorData,
                signature: signature,
                userHandle: userHandle
            )
        }
    }

    /// The fixed code for a system error. Its text is matched for the one
    /// domain-association case and otherwise never used.
    private static func failure(for error: Error) -> PasskeyFailure {
        guard let authorizationError = error as? ASAuthorizationError else {
            return .failed
        }
        switch authorizationError.code {
        case .canceled:
            return .cancelled
        case .failed:
            let described = error as NSError
            let texts = [described.localizedFailureReason ?? "", described.localizedDescription]
            return PasskeyWire.isDomainAssociationFailure(texts) ? .unavailable : .failed
        default:
            return .failed
        }
    }

    /// True for the first caller only: the call settles exactly once.
    private func claimFinish() -> Bool {
        lock.lock()
        defer { lock.unlock() }
        if finished {
            return false
        }
        finished = true
        return true
    }

    // MARK: ASAuthorizationControllerDelegate

    func authorizationController(
        controller: ASAuthorizationController,
        didCompleteWithAuthorization authorization: ASAuthorization
    ) {
        guard claimFinish() else { return }
        if let json = credentialJson(authorization.credential) {
            call.resolve(["credentialJson": json])
        } else {
            PasskeyPlugin.refuse(call, .failed)
        }
        // Last: this drops the reference that keeps `self` alive.
        PasskeyPlugin.ceremonyEnded()
    }

    func authorizationController(controller: ASAuthorizationController, didCompleteWithError error: Error) {
        guard claimFinish() else { return }
        PasskeyPlugin.refuse(call, Self.failure(for: error))
        // Last: this drops the reference that keeps `self` alive.
        PasskeyPlugin.ceremonyEnded()
    }

    // MARK: ASAuthorizationControllerPresentationContextProviding

    func presentationAnchor(for controller: ASAuthorizationController) -> ASPresentationAnchor {
        anchor
    }
}
