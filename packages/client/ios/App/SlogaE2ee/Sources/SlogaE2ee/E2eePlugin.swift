// E2eePlugin.swift: the Capacitor plugin `E2ee` (IE plan D5, §5). The
// webview's CapacitorTransport (e2ee.ts) talks to it with the Android
// plugin's contract: resolve `{json}`, reject with the core's error JSON as
// the message, `invalid_argument{field}` for a missing or mistyped argument.
//
// Routing comes from the one table, E2eeCommands:
//   - generic: `call` runs it on the serial engine worker (one switch below);
//   - native: `call` hands the two attachment export commands to
//     AttachmentTransfer on a thread of their own;
//   - dedicated: its own plugin method, on a NEW thread per call, because it
//     blocks (a native dialog, the recovery sheet, the network) and an open
//     dialog must never stall decrypt and send on the engine worker (D1 a);
//   - out: refused as an unknown command.
// Capacitor calls these methods on its bridge queue, so each one only reads
// its arguments and hands off. Nothing here runs on the main thread and
// nothing here is logged.
import AcutestE2eeBindings
import Capacitor
import Foundation

@objc(E2eePlugin)
public final class E2eePlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "E2eePlugin"
    public let jsName = "E2ee"
    public let pluginMethods: [CAPPluginMethod] =
        [CAPPluginMethod(name: "call", returnType: CAPPluginReturnPromise)]
        + E2eeCommands.dedicatedMethods.map { method -> CAPPluginMethod in
            CAPPluginMethod(name: method, returnType: CAPPluginReturnPromise)
        }

    // Armed only by SlogaBridgeViewController, right after the main-frame
    // bridge guard is installed and just before it registers the plugin.
    // Capacitor can also create a plugin on its own: for an unknown pluginId
    // its handleJSCall falls back to NSClassFromString(pluginId)
    // (CapacitorBridge.swift:473-479), so a message naming "E2eePlugin" would
    // load this class even in a process where the guard failed to install
    // and the plugin was deliberately never registered. Every method checks
    // the flag first, so "no guard, no E2EE" holds on that path too.
    private static let armLock = NSLock()
    private static var armed = false

    /// Called once by the bridge view controller after the guard is in place.
    static func arm() {
        armLock.lock()
        armed = true
        armLock.unlock()
    }

    private static func armedOrReject(_ call: CAPPluginCall) -> Bool {
        armLock.lock()
        let isArmed = armed
        armLock.unlock()
        if !isArmed {
            call.reject(E2eeReject.cryptoFailure.json)
        }
        return isArmed
    }

    @objc func call(_ call: CAPPluginCall) {
        guard Self.armedOrReject(call) else { return }
        // `__cmd`, not `name`: the arguments are spread beside it, and
        // `name` is an argument of e2ee_attachment_prepare.
        guard let name = Self.validated(call, { try E2eeCallArgs(call).string("__cmd") }) else {
            return
        }
        switch E2eeCommands.route(for: name) {
        case .generic:
            E2eeRuntime.shared.engineWorker.submit {
                dispatchPrecondition(condition: .notOnQueue(.main))
                Self.settle(call) {
                    let json = try E2eeRuntime.shared.withBackgroundTask("gg.sloga.e2ee.call") {
                        try Self.runGeneric(name, E2eeCallArgs(call))
                    }
                    return .json(json)
                }
            }
        case .native:
            guard let job = Self.validated(call, { try Self.nativeJob(name, E2eeCallArgs(call)) }) else {
                return
            }
            Self.onDedicatedThread(call, "gg.sloga.e2ee.attachment-export", job)
        case .dedicated, .out:
            // A dedicated command sent through `call` would skip its own
            // method and thread: refuse it exactly like an unknown one.
            call.reject(E2eeReject.invalidArgument("name").json)
        }
    }

    @objc func wipe(_ call: CAPPluginCall) {
        guard Self.armedOrReject(call) else { return }
        Self.onDedicatedThread(call, "gg.sloga.e2ee.wipe") {
            dispatchPrecondition(condition: .notOnQueue(.main))
            // Blocks on the core's wipe dialog; cancel rejects `declined`.
            try E2eeRuntime.shared.engine().wipe()
            // Desktop parity: a recovery sheet left open must not keep
            // showing a code for the identity that was just destroyed.
            RecoverySheet.teardown()
            return .json("null")
        }
    }

    @objc func downgrade(_ call: CAPPluginCall) {
        guard Self.armedOrReject(call) else { return }
        let args = E2eeCallArgs(call)
        guard let input = Self.validated(call, {
            try (
                conversationId: args.string("conversationId"),
                selfUserId: args.string("selfUserId"),
                bundles: args.optionalArrayJSON("bundles")
            )
        }) else {
            return
        }
        Self.onDedicatedThread(call, "gg.sloga.e2ee.downgrade") {
            dispatchPrecondition(condition: .notOnQueue(.main))
            // Plaintext direction: only the core's dialog can commit it.
            let json = try E2eeRuntime.shared.engine().downgrade(
                conversationId: input.conversationId,
                selfUserId: input.selfUserId,
                bundlesJson: input.bundles
            )
            return .json(json)
        }
    }

    @objc func confirmPeerDowngradeAccept(_ call: CAPPluginCall) {
        guard Self.armedOrReject(call) else { return }
        guard let conversationId = Self.validated(call, {
            try E2eeCallArgs(call).string("conversationId")
        }) else {
            return
        }
        Self.onDedicatedThread(call, "gg.sloga.e2ee.peer-downgrade-accept") {
            dispatchPrecondition(condition: .notOnQueue(.main))
            // Blocks on the core's peer-downgrade dialog. A cancelled accept
            // is turned into a decline by the core, so either way the
            // promise settles with null and only a tap moves to plaintext.
            try E2eeRuntime.shared.engine().confirmPeerDowngrade(conversationId: conversationId, accept: true)
            return .json("null")
        }
    }

    @objc func enableGroup(_ call: CAPPluginCall) {
        guard Self.armedOrReject(call) else { return }
        let args = E2eeCallArgs(call)
        guard let input = Self.validated(call, {
            try (
                conversationId: args.string("conversationId"),
                roster: args.strings("roster"),
                selfUserId: args.string("selfUserId"),
                bundles: args.optionalArrayJSON("bundles"),
                displayNames: args.optionalStringMap("displayNames")
            )
        }) else {
            return
        }
        Self.onDedicatedThread(call, "gg.sloga.e2ee.enable-group") {
            dispatchPrecondition(condition: .notOnQueue(.main))
            // Blocks on the core's growth dialog. The names only label its
            // lines; what the commit asserts is decided by the core.
            let json = try E2eeRuntime.shared.engine().enableGroup(
                conversationId: input.conversationId,
                roster: input.roster,
                selfUserId: input.selfUserId,
                bundlesJson: input.bundles,
                displayNames: input.displayNames
            )
            return .json(json)
        }
    }

    @objc func addGroupMember(_ call: CAPPluginCall) {
        guard Self.armedOrReject(call) else { return }
        let args = E2eeCallArgs(call)
        guard let input = Self.validated(call, {
            try (
                conversationId: args.string("conversationId"),
                userId: args.string("userId"),
                selfUserId: args.string("selfUserId"),
                bundles: args.optionalArrayJSON("bundles"),
                displayNames: args.optionalStringMap("displayNames")
            )
        }) else {
            return
        }
        Self.onDedicatedThread(call, "gg.sloga.e2ee.add-group-member") {
            dispatchPrecondition(condition: .notOnQueue(.main))
            // Blocks on the core's growth dialog, as for enableGroup.
            let json = try E2eeRuntime.shared.engine().addGroupMember(
                conversationId: input.conversationId,
                userId: input.userId,
                selfUserId: input.selfUserId,
                bundlesJson: input.bundles,
                displayNames: input.displayNames
            )
            return .json(json)
        }
    }

    @objc func markVerified(_ call: CAPPluginCall) {
        guard Self.armedOrReject(call) else { return }
        let args = E2eeCallArgs(call)
        guard let input = Self.validated(call, {
            try (
                peerUserId: args.string("peerUserId"),
                deviceId: args.string("deviceId"),
                selfUserId: args.string("selfUserId"),
                displayName: args.optionalString("displayName")
            )
        }) else {
            return
        }
        Self.onDedicatedThread(call, "gg.sloga.e2ee.mark-verified") {
            dispatchPrecondition(condition: .notOnQueue(.main))
            // Blocks on the core's verify dialog; the commit is bound to the
            // safety number it showed.
            try E2eeRuntime.shared.engine().markVerified(
                peerUserId: input.peerUserId,
                deviceId: input.deviceId,
                selfUserId: input.selfUserId,
                displayName: input.displayName
            )
            return .empty
        }
    }

    @objc func acceptIdentityChange(_ call: CAPPluginCall) {
        guard Self.armedOrReject(call) else { return }
        let args = E2eeCallArgs(call)
        guard let input = Self.validated(call, {
            try (
                peerUserId: args.string("peerUserId"),
                deviceId: args.string("deviceId"),
                selfUserId: args.string("selfUserId"),
                displayName: args.optionalString("displayName")
            )
        }) else {
            return
        }
        Self.onDedicatedThread(call, "gg.sloga.e2ee.accept-identity-change") {
            dispatchPrecondition(condition: .notOnQueue(.main))
            // Blocks on the core's accept dialog; keys swapped while it was
            // open are refused by the core.
            try E2eeRuntime.shared.engine().acceptIdentityChange(
                peerUserId: input.peerUserId,
                deviceId: input.deviceId,
                selfUserId: input.selfUserId,
                displayName: input.displayName
            )
            return .empty
        }
    }

    @objc func backupCreate(_ call: CAPPluginCall) {
        guard Self.armedOrReject(call) else { return }
        guard let userId = Self.validated(call, { try E2eeCallArgs(call).string("userId") }) else {
            return
        }
        Self.onDedicatedThread(call, "gg.sloga.e2ee.backup-create") {
            dispatchPrecondition(condition: .notOnQueue(.main))
            // The code is shown in the native sheet only; the webview gets
            // the ciphertext bundle.
            return .json(try RecoverySheet.runCreateOrRotate(rotate: false, userId: userId))
        }
    }

    @objc func backupRotate(_ call: CAPPluginCall) {
        guard Self.armedOrReject(call) else { return }
        guard let userId = Self.validated(call, { try E2eeCallArgs(call).string("userId") }) else {
            return
        }
        Self.onDedicatedThread(call, "gg.sloga.e2ee.backup-rotate") {
            dispatchPrecondition(condition: .notOnQueue(.main))
            return .json(try RecoverySheet.runCreateOrRotate(rotate: true, userId: userId))
        }
    }

    @objc func backupRestore(_ call: CAPPluginCall) {
        guard Self.armedOrReject(call) else { return }
        let args = E2eeCallArgs(call)
        guard let input = Self.validated(call, {
            // A missing `blobsJson` reports field "blobs", as Android does.
            try (userId: args.string("userId"), blobsJson: args.string("blobsJson", field: "blobs"))
        }) else {
            return
        }
        Self.onDedicatedThread(call, "gg.sloga.e2ee.backup-restore") {
            dispatchPrecondition(condition: .notOnQueue(.main))
            // The code is typed into the native sheet, never the webview.
            return .json(try RecoverySheet.runRestore(userId: input.userId, blobsJson: input.blobsJson))
        }
    }

    @objc func attachmentUpload(_ call: CAPPluginCall) {
        guard Self.armedOrReject(call) else { return }
        let args = E2eeCallArgs(call)
        guard let input = Self.validated(call, {
            try (
                localId: args.string("localId"),
                url: args.string("url"),
                authHeader: args.string("authHeader"),
                authValue: args.string("authValue"),
                recipientsJson: args.string("recipientsJson")
            )
        }) else {
            return
        }
        Self.onDedicatedThread(call, "gg.sloga.e2ee.attachment-upload") {
            dispatchPrecondition(condition: .notOnQueue(.main))
            // Ciphertext moves natively and never crosses the bridge; the
            // transfer checks `url` against the pinned Autumn origin.
            let json = try AttachmentTransfer.upload(
                localId: input.localId,
                url: input.url,
                authHeader: input.authHeader,
                authValue: input.authValue,
                recipientsJson: input.recipientsJson
            )
            return .json(json)
        }
    }

    @objc func attachmentFetch(_ call: CAPPluginCall) {
        guard Self.armedOrReject(call) else { return }
        let args = E2eeCallArgs(call)
        guard let input = Self.validated(call, {
            try (
                localId: args.string("localId"),
                url: args.string("url"),
                authHeader: args.string("authHeader"),
                authValue: args.string("authValue")
            )
        }) else {
            return
        }
        Self.onDedicatedThread(call, "gg.sloga.e2ee.attachment-fetch") {
            dispatchPrecondition(condition: .notOnQueue(.main))
            let json = try AttachmentTransfer.fetch(
                localId: input.localId,
                url: input.url,
                authHeader: input.authHeader,
                authValue: input.authValue
            )
            return .json(json)
        }
    }
}

private extension E2eePlugin {
    /// How a call settles: `{json}`, or `{}` (markVerified,
    /// acceptIdentityChange).
    enum Resolution {
        case json(String)
        case empty
    }

    /// Reads arguments on the bridge queue; on a bad argument the call is
    /// rejected and nil is returned, so nothing is handed off.
    static func validated<T>(_ call: CAPPluginCall, _ read: () throws -> T) -> T? {
        do {
            return try read()
        } catch {
            call.reject(rejectJson(for: error))
            return nil
        }
    }

    /// Settles `call` exactly once from `body`. Errors go through
    /// `rejectJson`, so the webview never sees a raw Swift error.
    static func settle(_ call: CAPPluginCall, _ body: () throws -> Resolution) {
        do {
            switch try body() {
            case .json(let json):
                call.resolve(["json": json])
            case .empty:
                call.resolve([:])
            }
        } catch {
            call.reject(rejectJson(for: error))
        }
    }

    /// Runs `body` on a NEW thread of its own (8 MiB stack), inside a
    /// background task, and settles `call` with its result.
    static func onDedicatedThread(_ call: CAPPluginCall, _ name: String, _ body: @escaping () throws -> Resolution) {
        runOnDedicatedThread(name: name) {
            dispatchPrecondition(condition: .notOnQueue(.main))
            settle(call) {
                try E2eeRuntime.shared.withBackgroundTask(name, body)
            }
        }
    }

    /// The two native attachment exports. Swift owns the consent and the
    /// write (AttachmentTransfer); the plaintext never comes back here.
    static func nativeJob(_ name: String, _ args: E2eeCallArgs) throws -> () throws -> Resolution {
        let export: (String, UInt32) throws -> String
        switch name {
        case "e2ee_attachment_copy_image":
            export = AttachmentTransfer.copyImage(messageId:idx:)
        case "e2ee_attachment_save":
            export = AttachmentTransfer.save(messageId:idx:)
        default:
            throw E2eeReject.invalidArgument("name")
        }
        let messageId = try args.string("messageId")
        let idx = try args.uint32("idx")
        return {
            dispatchPrecondition(condition: .notOnQueue(.main))
            return .json(try export(messageId, idx))
        }
    }

    /// The generic commands, on the engine worker. The case labels are
    /// exactly the 37 generic names of E2eeCommands: a confirm-gated
    /// command here would run without its own thread, and a native-only
    /// engine method here would hand a recovery code or plaintext to the
    /// webview (G8), so neither kind ever appears. JSON text from the core
    /// passes through unchanged; a bare string is quoted, unit is `null`.
    static func runGeneric(_ name: String, _ args: E2eeCallArgs) throws -> String {
        dispatchPrecondition(condition: .notOnQueue(.main))
        let engine = try E2eeRuntime.shared.engine()
        switch name {
        case "e2ee_status":
            return try engine.status()
        case "e2ee_is_provisioned":
            // Filesystem check only: never opens or provisions the store,
            // so a fresh install stays open to key-backup restore.
            return try engine.isProvisioned() ? "true" : "false"
        case "e2ee_store_owner":
            // nil is UNKNOWN, never "it is yours".
            return try engine.storeOwner().map(jsonQuote) ?? "null"
        case "e2ee_enable":
            return try engine.enable()
        case "e2ee_mark_published":
            try engine.markPublished()
            return "null"
        case "e2ee_replenish":
            return try engine.replenish(serverRemaining: args.uint64("serverRemaining"))
        case "e2ee_sign_claim":
            return try jsonQuote(engine.signClaim(sessionId: args.string("sessionId"), nonce: args.string("nonce")))
        case "e2ee_encrypt":
            return try engine.encrypt(
                peerUserId: args.string("peerUserId"),
                selfUserId: args.string("selfUserId"),
                peerBundleJson: args.optionalObjectJSON("peerBundle"),
                selfBundleJson: args.optionalObjectJSON("selfBundle"),
                content: args.string("content"),
                attachments: args.optionalStrings("attachments") ?? []
            )
        case "e2ee_decrypt":
            // The self id is its own argument, never read from the
            // server-built envelope. Absent (an older frontend) is nil.
            return try engine.decrypt(
                envelopeJson: args.objectJSON("envelope"),
                selfUserId: args.optionalString("selfUserId")
            )
        case "e2ee_history":
            return try engine.history(
                peerUserId: args.string("peerUserId"),
                before: args.optionalString("before"),
                limit: args.optionalUInt32("limit") ?? 50
            )
        case "e2ee_send_mode":
            return try engine.sendMode(peerUserId: args.string("peerUserId"))
        case "e2ee_conversation_state":
            return try engine.conversationState(peerUserId: args.string("peerUserId"))
        case "e2ee_reconcile_devices":
            return try engine.reconcileDevices(userId: args.string("userId"), devicesJson: args.arrayJSON("devices"))
        case "e2ee_handle_receipts":
            return try engine.handleReceipts(receiptsJson: args.arrayJSON("receipts"))
        case "e2ee_device_removed":
            try engine.deviceRemoved(userId: args.string("userId"), deviceId: args.string("deviceId"))
            return "null"
        case "e2ee_send_mode_group":
            return try engine.sendModeGroup(conversationId: args.string("conversationId"))
        case "e2ee_acknowledge_group_plaintext":
            // The one documented no-dialog exception: the core refuses it
            // once any conversation row exists, and parses `expected` itself.
            try engine.acknowledgeGroupPlaintext(
                conversationId: args.string("conversationId"),
                expected: args.string("expected")
            )
            return "null"
        case "e2ee_encrypt_group":
            return try engine.encryptGroup(
                conversationId: args.string("conversationId"),
                selfUserId: args.string("selfUserId"),
                bundlesJson: args.optionalArrayJSON("bundles"),
                content: args.string("content"),
                attachments: args.optionalStrings("attachments") ?? []
            )
        case "e2ee_group_reconcile":
            // `displayed` is required: a missing list must not read as
            // "every member left".
            return try engine.groupReconcile(
                conversationId: args.string("conversationId"),
                displayed: args.strings("displayed"),
                selfUserId: args.string("selfUserId")
            )
        case "e2ee_group_state":
            return try engine.groupState(conversationId: args.string("conversationId"))
        case "e2ee_safety_number":
            return try engine.safetyNumber(
                selfUserId: args.string("selfUserId"),
                peerUserId: args.string("peerUserId"),
                deviceId: args.string("deviceId")
            )
        case "e2ee_confirm_peer_downgrade":
            // DECLINE only. Accepting moves the conversation to plaintext
            // and takes a tap on the dialog behind confirmPeerDowngradeAccept;
            // a webview asking for it here is refused, never accepted.
            if try args.optionalBool("accept") == true {
                throw E2eeReject.invalidArgument("accept")
            }
            try engine.confirmPeerDowngrade(conversationId: args.string("conversationId"), accept: false)
            return "null"
        case "e2ee_resend_downgrade":
            return try engine.resendDowngrade(
                conversationId: args.string("conversationId"),
                selfUserId: args.string("selfUserId"),
                bundlesJson: args.optionalArrayJSON("bundles")
            )
        case "e2ee_mark_downgrade_delivered":
            try engine.markDowngradeDelivered(conversationId: args.string("conversationId"))
            return "null"
        case "e2ee_pending_downgrades":
            return try engine.pendingDowngrades()
        case "e2ee_notify_downgrade":
            return try engine.notifyDowngrade(
                conversationId: args.string("conversationId"),
                selfUserId: args.string("selfUserId"),
                bundlesJson: args.optionalArrayJSON("bundles")
            )
        case "e2ee_downgraded_conversations":
            return try engine.downgradedConversations()
        case "e2ee_attachment_prepare":
            let peerUserId = try args.string("peerUserId")
            let fileName = try args.string("name")
            let mime = try args.string("mime")
            var plaintext = try args.base64("plaintextBase64")
            // Best effort: our copy of the file does not outlive the call.
            defer { zeroize(&plaintext) }
            return try engine.attachmentPrepare(peerUserId: peerUserId, name: fileName, mime: mime, plaintext: plaintext)
        case "e2ee_attachment_attach_blob":
            try engine.attachmentAttachBlob(localId: args.string("localId"), blobId: args.string("blobId"))
            return "null"
        case "e2ee_attachment_mark_unavailable":
            try engine.attachmentMarkUnavailable(localId: args.string("localId"), expired: args.bool("expired"))
            return "null"
        case "e2ee_attachment_recipients":
            return try engine.attachmentRecipients(
                peerUserId: args.string("peerUserId"),
                selfUserId: args.string("selfUserId")
            )
        case "e2ee_attachment_recipients_group":
            return try engine.attachmentRecipientsGroup(
                conversationId: args.string("conversationId"),
                selfUserId: args.string("selfUserId")
            )
        case "e2ee_backup_status":
            return try engine.backupStatus()
        case "e2ee_backup_refresh_if_due":
            let userId = try args.string("userId")
            // A recovery sheet that outlived a page load couriered its bundle
            // to the page that is gone; hand it to this page's next refresh,
            // which uploads whatever this returns.
            if let orphaned = RecoverySheet.takeOrphanedBundle() {
                return orphaned
            }
            return try engine.backupRefreshIfDue(userId: userId)
        case "e2ee_backup_mark_uploaded":
            try engine.backupMarkUploaded(generation: args.int64("generation"))
            return "null"
        case "e2ee_backup_forget_local":
            try engine.backupForgetLocal()
            return "null"
        case "e2ee_backup_rederive_republish":
            // Public key material only, re-callable, never the code.
            return try engine.backupRederiveRepublish()
        default:
            throw E2eeReject.invalidArgument("name")
        }
    }
}

/// Strict readers over one call's arguments. A wrong type is rejected as
/// `invalid_argument{field}`, never coerced: a string where a number was
/// expected must not become 0, a boolean must not pass as 1, and a
/// fraction or negative must not be truncated or wrapped (Android audit
/// LOW-2). JSON `null` counts as absent.
private struct E2eeCallArgs {
    let call: CAPPluginCall

    init(_ call: CAPPluginCall) {
        self.call = call
    }

    private func value(_ key: String) -> Any? {
        guard let options = call.options, let value = options[key], !(value is NSNull) else {
            return nil
        }
        return value
    }

    private func invalid(_ field: String) -> E2eeReject {
        E2eeReject.invalidArgument(field)
    }

    // MARK: strings

    func string(_ key: String, field: String? = nil) throws -> String {
        guard let text = try optionalString(key, field: field) else {
            throw invalid(field ?? key)
        }
        return text
    }

    func optionalString(_ key: String, field: String? = nil) throws -> String? {
        guard let raw = value(key) else {
            return nil
        }
        guard let text = raw as? String else {
            throw invalid(field ?? key)
        }
        return text
    }

    /// Strict base64 (no whitespace, no unknown characters).
    func base64(_ key: String) throws -> Data {
        guard let data = Data(base64Encoded: try string(key)) else {
            throw invalid(key)
        }
        return data
    }

    func strings(_ key: String) throws -> [String] {
        guard let list = try optionalStrings(key) else {
            throw invalid(key)
        }
        return list
    }

    func optionalStrings(_ key: String) throws -> [String]? {
        guard let raw = value(key) else {
            return nil
        }
        guard let items = raw as? [Any] else {
            throw invalid(key)
        }
        var list: [String] = []
        list.reserveCapacity(items.count)
        for item in items {
            guard let text = item as? String else {
                throw invalid(key)
            }
            list.append(text)
        }
        return list
    }

    func optionalStringMap(_ key: String) throws -> [String: String]? {
        guard let raw = value(key) else {
            return nil
        }
        guard let entries = raw as? [String: Any] else {
            throw invalid(key)
        }
        var map: [String: String] = [:]
        for (entryKey, entryValue) in entries {
            guard let text = entryValue as? String else {
                throw invalid(key)
            }
            map[entryKey] = text
        }
        return map
    }

    // MARK: JSON text for the core

    func objectJSON(_ key: String) throws -> String {
        guard let json = try optionalObjectJSON(key) else {
            throw invalid(key)
        }
        return json
    }

    func optionalObjectJSON(_ key: String) throws -> String? {
        guard let raw = value(key) else {
            return nil
        }
        guard raw is [String: Any] else {
            throw invalid(key)
        }
        return try jsonText(raw, key)
    }

    func arrayJSON(_ key: String) throws -> String {
        guard let json = try optionalArrayJSON(key) else {
            throw invalid(key)
        }
        return json
    }

    func optionalArrayJSON(_ key: String) throws -> String? {
        guard let raw = value(key) else {
            return nil
        }
        guard raw is [Any] else {
            throw invalid(key)
        }
        return try jsonText(raw, key)
    }

    /// Re-serialized for the core's own strict parser. The validity check
    /// comes first because JSONSerialization raises (it does not throw) on
    /// an object it cannot write.
    private func jsonText(_ raw: Any, _ key: String) throws -> String {
        guard JSONSerialization.isValidJSONObject(raw),
              let data = try? JSONSerialization.data(withJSONObject: raw, options: [])
        else {
            throw invalid(key)
        }
        return String(decoding: data, as: UTF8.self)
    }

    // MARK: booleans

    func bool(_ key: String) throws -> Bool {
        guard let flag = try optionalBool(key) else {
            throw invalid(key)
        }
        return flag
    }

    /// A JSON boolean only; the number 1 is not `true`.
    func optionalBool(_ key: String) throws -> Bool? {
        guard let raw = value(key) else {
            return nil
        }
        guard let number = raw as? NSNumber, CFGetTypeID(number) == CFBooleanGetTypeID() else {
            throw invalid(key)
        }
        return number.boolValue
    }

    // MARK: integers

    private enum Integral {
        case signed(Int64)
        case unsigned(UInt64)
    }

    /// A JSON number with no fractional part, read at full width. A boolean
    /// is an NSNumber too and is refused.
    private func integral(_ key: String) throws -> Integral? {
        guard let raw = value(key) else {
            return nil
        }
        guard let number = raw as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID() else {
            throw invalid(key)
        }
        switch String(cString: number.objCType) {
        case "c", "s", "i", "l", "q":
            return .signed(number.int64Value)
        case "C", "S", "I", "L", "Q":
            return .unsigned(number.uint64Value)
        case "f", "d":
            let double = number.doubleValue
            if let signed = Int64(exactly: double) {
                return .signed(signed)
            }
            if let unsigned = UInt64(exactly: double) {
                return .unsigned(unsigned)
            }
            throw invalid(key)
        default:
            throw invalid(key)
        }
    }

    /// u64, at least 0 (`serverRemaining`).
    func uint64(_ key: String) throws -> UInt64 {
        switch try integral(key) {
        case .signed(let signed)?:
            guard let unsigned = UInt64(exactly: signed) else {
                throw invalid(key)
            }
            return unsigned
        case .unsigned(let unsigned)?:
            return unsigned
        case nil:
            throw invalid(key)
        }
    }

    /// i64 (`generation`).
    func int64(_ key: String) throws -> Int64 {
        switch try integral(key) {
        case .signed(let signed)?:
            return signed
        case .unsigned(let unsigned)?:
            guard let signed = Int64(exactly: unsigned) else {
                throw invalid(key)
            }
            return signed
        case nil:
            throw invalid(key)
        }
    }

    /// u32 (`idx`).
    func uint32(_ key: String) throws -> UInt32 {
        guard let small = try optionalUInt32(key) else {
            throw invalid(key)
        }
        return small
    }

    /// u32 or absent (`limit`).
    func optionalUInt32(_ key: String) throws -> UInt32? {
        switch try integral(key) {
        case .signed(let signed)?:
            guard let small = UInt32(exactly: signed) else {
                throw invalid(key)
            }
            return small
        case .unsigned(let unsigned)?:
            guard let small = UInt32(exactly: unsigned) else {
                throw invalid(key)
            }
            return small
        case nil:
            return nil
        }
    }
}
