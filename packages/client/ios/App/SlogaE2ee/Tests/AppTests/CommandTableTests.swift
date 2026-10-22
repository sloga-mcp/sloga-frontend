// CommandTableTests (lane T6, IE Wave 3, gate G9): the iOS E2ee plugin's
// command table and its Capacitor bridge contract (plan D5, §5).
//
// What is pinned, and why it matters:
//   - The table: counts, name shape, the exact 37 generic commands, the 6
//     confirm-gated names and the 12 dedicated methods. A confirm-gated name
//     drifting to generic would run a consent commit on the engine worker
//     instead of its own thread; a native-only, secret-bearing name becoming
//     routable would hand a recovery code or plaintext to the webview.
//   - The surface Capacitor resolves: JS name, method list, selectors.
//   - Behaviour through a real CAPPluginCall, invoked the way Capacitor's
//     handleJSCall does (`perform(selector, with:)` on a serial queue):
//     the exact reject JSON CapacitorTransport parses, settle exactly once,
//     refused commands refused before any hand-off, and no consent dialog.
//
// Engine use: the plugin always goes through E2eeRuntime.shared, i.e. the
// app's REAL store directory. Valid arguments are sent only to commands that
// never provision (is_provisioned, status, send_mode). Every other command
// here carries arguments the plugin must refuse before an engine method runs.
// wipe (no arguments to get wrong) is therefore never invoked.
//
// Known-bad control: set `t6Control` to true. Every expectation then switches
// to a deliberately wrong twin, and every test in this class must fail.
import AcutestE2eeBindings
import Capacitor
import UIKit
import XCTest
@testable import SlogaE2ee

/// false in the checked-in file. The control run uses a copy with true.
private let t6Control = false

/// `real`, or its deliberately wrong twin in the control run.
private func pin<T>(_ real: T, wrong: T) -> T {
    t6Control ? wrong : real
}

// MARK: - The contract (ie-w3-contracts.md "Plugin bridge contract"), typed in by hand

/// §5 IN column, generic `call` mux. Hand-typed from the contract, NOT read
/// from E2eeCommands, so the table cannot vouch for itself.
private let contractGeneric: [String] = [
    "e2ee_status",
    "e2ee_is_provisioned",
    "e2ee_store_owner",
    "e2ee_enable",
    "e2ee_mark_published",
    "e2ee_replenish",
    "e2ee_sign_claim",
    "e2ee_encrypt",
    "e2ee_decrypt",
    "e2ee_history",
    "e2ee_send_mode",
    "e2ee_conversation_state",
    "e2ee_reconcile_devices",
    "e2ee_handle_receipts",
    "e2ee_device_removed",
    "e2ee_send_mode_group",
    "e2ee_acknowledge_group_plaintext",
    "e2ee_encrypt_group",
    "e2ee_group_reconcile",
    "e2ee_group_state",
    "e2ee_safety_number",
    "e2ee_confirm_peer_downgrade",
    "e2ee_resend_downgrade",
    "e2ee_mark_downgrade_delivered",
    "e2ee_pending_downgrades",
    "e2ee_notify_downgrade",
    "e2ee_downgraded_conversations",
    "e2ee_attachment_prepare",
    "e2ee_attachment_attach_blob",
    "e2ee_attachment_mark_unavailable",
    "e2ee_attachment_recipients",
    "e2ee_attachment_recipients_group",
    "e2ee_backup_status",
    "e2ee_backup_refresh_if_due",
    "e2ee_backup_mark_uploaded",
    "e2ee_backup_forget_local",
    "e2ee_backup_rederive_republish",
]

private let contractNative: [String] = [
    "e2ee_attachment_copy_image",
    "e2ee_attachment_save",
]

private let contractDedicated: [String: String] = [
    "e2ee_wipe": "wipe",
    "e2ee_downgrade": "downgrade",
    "e2ee_enable_group": "enableGroup",
    "e2ee_add_group_member": "addGroupMember",
    "e2ee_mark_verified": "markVerified",
    "e2ee_accept_identity_change": "acceptIdentityChange",
]

private let contractDedicatedMethods: [String] = [
    "wipe",
    "downgrade",
    "confirmPeerDowngradeAccept",
    "enableGroup",
    "addGroupMember",
    "markVerified",
    "acceptIdentityChange",
    "backupCreate",
    "backupRotate",
    "backupRestore",
    "attachmentUpload",
    "attachmentFetch",
]

/// Names that must never be routable from the webview: the secret- or
/// plaintext-bearing native-only engine methods under FE-style names (G8b),
/// the desktop recovery window, the unimplemented call-downgrade method, the
/// modal ids, and near-misses of real names (case, whitespace, NUL, prefix).
private let unroutableNames: [String] = [
    "e2ee_call_frame_keys",
    "e2ee_call_confirm_downgrade",
    "callConfirmDowngrade",
    "e2ee_recovery_create",
    "e2ee_recovery_rotate",
    "e2ee_recovery_restore",
    "e2ee_recovery_finish",
    "e2ee_recovery_open",
    "e2ee_recovery_closed",
    "e2ee_recovery_context",
    "e2ee_backup_open_recovery",
    "e2ee_backup_take_pending_upload",
    "e2ee_backup_take_pending_republish",
    "e2ee_attachment_ciphertext",
    "e2ee_attachment_store",
    "e2ee_attachment_for_export",
    "e2ee_attachment_export_name",
    "e2ee_serve_attachment_for_render",
    "e2ee_disable",
    "e2ee_reenroll",
    "e2ee_verify",
    "e2ee_unverified",
    "e2ee_identity_change",
    "e2ee_peer_downgrade",
    "e2ee_group_plaintext_confirm",
    "",
    "e2ee_",
    "E2EE_STATUS",
    "e2ee_Status",
    "e2ee_status ",
    " e2ee_status",
    "e2ee_status" + String(Character(Unicode.Scalar(UInt8(0)))),
    "e2ee_wipe\n",
    "status",
    "wipe",
    "call",
]

/// Well-formed ULIDs for arguments that must look real, so a reject is about
/// routing and not about a malformed id.
private let peerId = "01J9Z3K4M5N6P7Q8R9S0T1V2W3"
private let selfId = "01J9Z3K4M5N6P7Q8R9S0T1V2W4"
private let deviceId = "01J9Z3K4M5N6P7Q8R9S0T1V2W5"
private let conversationId = "01J9Z3K4M5N6P7Q8R9S0T1V2W6"

// MARK: - Table helpers

private func tableNames(where matches: (E2eeRoute) -> Bool) -> [String] {
    E2eeCommands.table.filter { matches($0.route) }.map { $0.name }
}

private func dedicatedTarget(_ route: E2eeRoute) -> String? {
    if case .dedicated(let method) = route {
        return method
    }
    return nil
}

private func duplicates(_ names: [String]) -> [String] {
    var seen = Set<String>()
    var dupes: [String] = []
    for name in names where !seen.insert(name).inserted && !dupes.contains(name) {
        dupes.append(name)
    }
    return dupes
}

/// The G6 grep shape: `e2ee_` then at least one of [a-z0-9_].
private func malformedNames(_ names: [String]) -> [String] {
    names.filter { name in
        guard name.hasPrefix("e2ee_"), name.count > 5 else {
            return true
        }
        return !name.unicodeScalars.allSatisfy { scalar in
            ("a"..."z").contains(scalar) || ("0"..."9").contains(scalar) || scalar == "_"
        }
    }
}

// MARK: - Call capture

/// Lets a value cross into a queue/thread closure without a Sendable warning.
/// Only used for objects the test hands over once and never mutates.
private struct Handoff<Value>: @unchecked Sendable {
    let value: Value
}

private final class Locked<Value>: @unchecked Sendable {
    private let lock = NSLock()
    private var stored: Value

    init(_ value: Value) {
        stored = value
    }

    var value: Value {
        lock.lock()
        defer { lock.unlock() }
        return stored
    }

    func set(_ value: Value) {
        lock.lock()
        stored = value
        lock.unlock()
    }
}

private struct Rejection {
    let message: String
    let code: String?
    let data: [String: Any]?
}

private struct Outcome {
    var resolves: [[String: Any]] = []
    var rejects: [Rejection] = []

    var count: Int {
        resolves.count + rejects.count
    }
}

/// Capturing success/error handlers for one CAPPluginCall.
private final class Probe: @unchecked Sendable {
    private let lock = NSLock()
    private var outcome = Outcome()
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
        outcome.rejects.append(Rejection(message: error?.message ?? "<nil error>", code: error?.code, data: error?.data))
        lock.unlock()
        settled.fulfill()
    }

    var snapshot: Outcome {
        lock.lock()
        defer { lock.unlock() }
        return outcome
    }
}

private struct Invocation {
    let outcome: Outcome
    /// Settled before the plugin method returned on the bridge queue, so the
    /// call was refused without handing anything to another thread.
    let settledInline: Bool
}

private func jsonValue(_ text: String) -> Any? {
    guard let data = text.data(using: .utf8) else {
        return nil
    }
    return try? JSONSerialization.jsonObject(with: data, options: [.fragmentsAllowed])
}

private func isJSONBool(_ value: Any?) -> Bool {
    guard let number = value as? NSNumber else {
        return false
    }
    return CFGetTypeID(number) == CFBooleanGetTypeID()
}

final class CommandTableTests: XCTestCase {
    /// Stand-in for Capacitor's serial "bridge" queue (CapacitorBridge.swift:131).
    private let bridgeQueue = DispatchQueue(label: "t6.bridge")

    override func tearDown() {
        // Safety net: if a broken build ever let a refused command reach a
        // consent prompt, decline it so nothing can be committed.
        NativeConfirmPresenter.shared.declineAll()
        super.tearDown()
    }

    // MARK: Table

    func testTableHasNoDuplicateNames() {
        let all = E2eeCommands.table.map { $0.name }
        // Detector control: a duplicate planted in a copy is found.
        XCTAssertEqual(duplicates(all + ["e2ee_wipe"]), pin(["e2ee_wipe"], wrong: []))
        XCTAssertEqual(duplicates(all), pin([], wrong: ["e2ee_status"]))
        XCTAssertEqual(Set(all).count, all.count)
    }

    func testRouteCountsMatchThePins() {
        let generic = tableNames { $0 == .generic }
        let native = tableNames { $0 == .native }
        let dedicated = tableNames { dedicatedTarget($0) != nil }
        let out = tableNames { $0 == .out }

        XCTAssertEqual(generic.count, pin(37, wrong: 36))
        XCTAssertEqual(native.count, 2)
        XCTAssertEqual(dedicated.count, 6)
        XCTAssertEqual(out.count, E2eeCommands.outCount)
        XCTAssertEqual(E2eeCommands.genericCount, 37)
        XCTAssertEqual(E2eeCommands.nativeCount, 2)
        XCTAssertEqual(E2eeCommands.dedicatedCount, 6)
        XCTAssertEqual(E2eeCommands.table.count, 37 + 2 + 6 + E2eeCommands.outCount)
    }

    func testEveryNameIsAnE2eeCommandName() {
        // Detector control: each malformed shape is caught, the good one is not.
        XCTAssertEqual(
            malformedNames(["e2ee_ok_1", "E2EE_X", "call_x", "e2ee_", "e2ee_a-b", "e2ee_Status"]),
            pin(["E2EE_X", "call_x", "e2ee_", "e2ee_a-b", "e2ee_Status"], wrong: [])
        )
        XCTAssertEqual(malformedNames(E2eeCommands.table.map { $0.name }), pin([], wrong: ["e2ee_status"]))
    }

    func testGenericSetIsExactlyTheContract37() {
        XCTAssertEqual(contractGeneric.count, 37, "the hand-typed contract list itself")
        XCTAssertEqual(duplicates(contractGeneric), [])

        let generic = Set(tableNames { $0 == .generic })
        let expected = Set(pin(contractGeneric, wrong: Array(contractGeneric.dropLast())))
        XCTAssertEqual(generic, expected, "extra: \(generic.subtracting(expected).sorted()), missing: \(expected.subtracting(generic).sorted())")
    }

    func testNativeSetIsExact() {
        XCTAssertEqual(tableNames { $0 == .native }, pin(contractNative, wrong: [contractNative[0]]))
    }

    func testDedicatedMappingsAreExact() {
        var mapping: [String: String] = [:]
        for entry in E2eeCommands.table {
            if let method = dedicatedTarget(entry.route) {
                mapping[entry.name] = method
            }
        }
        XCTAssertEqual(mapping, pin(contractDedicated, wrong: contractDedicated.merging(["e2ee_wipe": "downgrade"]) { $1 }))
        // Every confirm-gated name points at a method the plugin really has.
        for method in mapping.values {
            XCTAssertTrue(E2eeCommands.dedicatedMethods.contains(method), method)
        }
    }

    func testDedicatedMethodsAreExactInOrder() {
        XCTAssertEqual(E2eeCommands.dedicatedMethods, pin(contractDedicatedMethods, wrong: contractDedicatedMethods.reversed()))
        XCTAssertFalse(E2eeCommands.dedicatedMethods.contains("callConfirmDowngrade"))
        XCTAssertFalse(E2eeCommands.dedicatedMethods.contains("call"))
    }

    func testUnroutableNamesRouteOut() {
        // Discrimination control: route(for:) is not simply "always .out".
        XCTAssertEqual(E2eeCommands.route(for: "e2ee_status"), .generic)
        XCTAssertEqual(E2eeCommands.route(for: "e2ee_attachment_save"), .native)
        XCTAssertEqual(E2eeCommands.route(for: "e2ee_wipe"), .dedicated("wipe"))

        for name in unroutableNames {
            XCTAssertEqual(E2eeCommands.route(for: name), pin(.out, wrong: .generic), "route(for: \(name.debugDescription))")
        }
    }

    func testRouteLookupAgreesWithEveryTableEntry() {
        for entry in E2eeCommands.table {
            XCTAssertEqual(E2eeCommands.route(for: entry.name), pin(entry.route, wrong: .out), entry.name)
        }
    }

    // MARK: Plugin surface

    func testPluginIdentity() {
        let plugin = E2eePlugin()
        XCTAssertEqual(plugin.jsName, pin("E2ee", wrong: "E2eePlugin"))
        XCTAssertEqual(plugin.identifier, "E2eePlugin")
        XCTAssertEqual(NSStringFromClass(E2eePlugin.self), "E2eePlugin")
    }

    func testPluginMethodsAreCallThenTheDedicatedMethodsAllPromises() {
        let methods = E2eePlugin().pluginMethods
        let names = methods.map { $0.name ?? "" }
        XCTAssertEqual(names, pin(["call"] + contractDedicatedMethods, wrong: contractDedicatedMethods))
        XCTAssertEqual(names, ["call"] + E2eeCommands.dedicatedMethods)
        XCTAssertFalse(names.contains("callConfirmDowngrade"))
        for method in methods {
            XCTAssertEqual(method.returnType ?? "", "promise", method.name ?? "")
            XCTAssertEqual(method.returnType ?? "", CAPPluginReturnPromise, method.name ?? "")
        }
    }

    func testEveryPluginMethodRespondsToItsSelector() {
        let plugin = E2eePlugin()
        for method in plugin.pluginMethods {
            let name = method.name ?? ""
            let selector = NSSelectorFromString(name + ":")
            // Capacitor resolves `name` to `selector`, then checks responds(to:)
            // (CapacitorBridge.swift:488-497): a miss is a silent no-op call.
            XCTAssertEqual(method.selector, selector, name)
            XCTAssertTrue(plugin.responds(to: selector), name)
        }
        // Discrimination control: absent methods really are absent.
        XCTAssertEqual(plugin.responds(to: NSSelectorFromString("callConfirmDowngrade:")), pin(false, wrong: true))
        XCTAssertFalse(plugin.responds(to: NSSelectorFromString("call")))
        XCTAssertFalse(plugin.responds(to: NSSelectorFromString("e2eeWipe:")))
    }

    func testRunningAppRegistersThisPluginUnderItsJsName() {
        let found: (className: String?, guardInstalled: Bool, byIdentifier: Bool)? = MainActor.assumeIsolated {
            let controllers = UIApplication.shared.connectedScenes
                .compactMap { $0 as? UIWindowScene }
                .flatMap { $0.windows }
                .compactMap { $0.rootViewController as? SlogaBridgeViewController }
            guard let controller = controllers.first, let bridge = controller.bridge else {
                return nil
            }
            let plugin = bridge.plugin(withName: "E2ee")
            return (
                plugin.map { NSStringFromClass(type(of: $0)) },
                controller.bridgeGuard != nil,
                bridge.plugin(withName: "E2eePlugin") != nil
            )
        }
        guard let found = found else {
            XCTFail("no SlogaBridgeViewController with a bridge in any window")
            return
        }
        XCTAssertEqual(found.className, pin("E2eePlugin", wrong: nil))
        XCTAssertTrue(found.guardInstalled, "the plugin may only be registered behind the main-frame guard")
        XCTAssertFalse(found.byIdentifier, "registered under its JS name only")
    }

    // MARK: Behaviour through a real CAPPluginCall

    func testCallWithoutCmdRejectsCmd() {
        let cases: [[String: Any]] = [
            [:],
            ["__cmd": NSNull()],
            ["__cmd": 5],
            ["__cmd": true],
            ["__cmd": ["e2ee_status"]],
            // `name` is not the command key (it is an argument of attachment_prepare).
            ["name": "e2ee_status"],
        ]
        for options in cases {
            let result = invoke("call", options)
            assertInvalidArgument(result, field: "__cmd", inline: true, "\(options)")
        }
    }

    func testDedicatedNamesThroughCallRejectNameAndPresentNoDialog() {
        let baseline = topIdentity()
        // Arguments a real dedicated method would accept, so the only thing
        // wrong is the route.
        let cases: [(String, [String: Any])] = [
            ("e2ee_wipe", [:]),
            ("e2ee_downgrade", ["conversationId": peerId, "selfUserId": selfId]),
            ("e2ee_enable_group", ["conversationId": conversationId, "roster": [peerId, selfId], "selfUserId": selfId]),
            ("e2ee_add_group_member", ["conversationId": conversationId, "userId": peerId, "selfUserId": selfId]),
            ("e2ee_mark_verified", ["peerUserId": peerId, "deviceId": deviceId, "selfUserId": selfId]),
            ("e2ee_accept_identity_change", ["peerUserId": peerId, "deviceId": deviceId, "selfUserId": selfId]),
        ]
        XCTAssertEqual(Set(cases.map { $0.0 }), Set(contractDedicated.keys))
        for (name, arguments) in cases {
            let result = invoke("call", arguments.merging(["__cmd": name]) { $1 })
            assertInvalidArgument(result, field: "name", inline: true, name)
        }
        assertNoDialog(since: baseline, "dedicated names sent through call")
    }

    func testOutAndUnknownNamesThroughCallRejectName() {
        let baseline = topIdentity()
        let outNames = tableNames { $0 == .out }
        XCTAssertEqual(outNames.count, E2eeCommands.outCount)
        for name in outNames + unroutableNames {
            let result = invoke("call", ["__cmd": name, "userId": selfId, "conversationId": conversationId])
            assertInvalidArgument(result, field: "name", inline: true, name.debugDescription)
        }
        assertNoDialog(since: baseline, "OUT and unknown names sent through call")
    }

    func testPeerDowngradeAcceptThroughCallIsRefused() {
        let baseline = topIdentity()
        // Accepting moves a conversation to plaintext: only the dedicated
        // method, behind the native dialog, may do it. A mistyped `accept`
        // must not be read as a decline either; it is refused outright.
        let accepts: [Any] = [true, 1, "true", [true]]
        for accept in accepts {
            let result = invoke("call", ["__cmd": "e2ee_confirm_peer_downgrade", "conversationId": peerId, "accept": accept])
            assertInvalidArgument(result, field: "accept", inline: nil, "accept: \(accept)")
        }
        assertNoDialog(since: baseline, "confirm_peer_downgrade accept through call")
    }

    func testReplenishRefusesAMistypedServerRemaining() {
        // Each of these would otherwise be coerced to a count; none may reach
        // replenish (which opens, and so provisions, the store).
        let values: [Any?] = [
            nil,
            NSNull(),
            true,
            false,
            1.5,
            -1,
            "5",
            NSNumber(value: -1.0), // a WebKit-shaped double
            NSNumber(value: 1e20), // beyond u64
            NSNumber(value: Double.nan),
        ]
        for value in values {
            var options: [String: Any] = ["__cmd": "e2ee_replenish"]
            options["serverRemaining"] = value
            let result = invoke("call", options)
            assertInvalidArgument(result, field: "serverRemaining", inline: nil, "serverRemaining: \(String(describing: value))")
        }
    }

    func testBackupMarkUploadedRefusesAMissingOrMistypedGeneration() {
        let values: [Any?] = [
            nil,
            NSNull(),
            "1",
            true,
            1.5,
            NSNumber(value: UInt64.max), // beyond i64
            NSNumber(value: 1e19), // beyond i64, as a double
        ]
        for value in values {
            var options: [String: Any] = ["__cmd": "e2ee_backup_mark_uploaded"]
            options["generation"] = value
            let result = invoke("call", options)
            assertInvalidArgument(result, field: "generation", inline: nil, "generation: \(String(describing: value))")
        }
    }

    func testNativeExportsRefuseBadArgumentsBeforeAnyHandOff() {
        let baseline = topIdentity()
        let cases: [([String: Any], String)] = [
            (["__cmd": "e2ee_attachment_save"], "messageId"),
            (["__cmd": "e2ee_attachment_save", "messageId": 5, "idx": 0], "messageId"),
            (["__cmd": "e2ee_attachment_save", "messageId": peerId], "idx"),
            (["__cmd": "e2ee_attachment_save", "messageId": peerId, "idx": -1], "idx"),
            (["__cmd": "e2ee_attachment_save", "messageId": peerId, "idx": 1.5], "idx"),
            (["__cmd": "e2ee_attachment_save", "messageId": peerId, "idx": true], "idx"),
            (["__cmd": "e2ee_attachment_save", "messageId": peerId, "idx": 4_294_967_296], "idx"),
            (["__cmd": "e2ee_attachment_save", "messageId": peerId, "idx": "0"], "idx"),
            (["__cmd": "e2ee_attachment_copy_image"], "messageId"),
            (["__cmd": "e2ee_attachment_copy_image", "messageId": peerId], "idx"),
        ]
        for (options, field) in cases {
            let result = invoke("call", options)
            assertInvalidArgument(result, field: field, inline: true, "\(options)")
        }
        // A folder picker or share sheet would show up as a new presented controller.
        assertNoDialog(since: baseline, "native exports with bad arguments")
    }

    func testDedicatedMethodsRefuseBadArgumentsBeforeAnyHandOff() {
        let baseline = topIdentity()
        let cases: [(String, [String: Any], String)] = [
            ("downgrade", [:], "conversationId"),
            ("downgrade", ["conversationId": peerId, "selfUserId": 5], "selfUserId"),
            ("downgrade", ["conversationId": peerId, "selfUserId": selfId, "bundles": ["a": 1]], "bundles"),
            ("confirmPeerDowngradeAccept", [:], "conversationId"),
            ("confirmPeerDowngradeAccept", ["conversationId": true], "conversationId"),
            ("enableGroup", ["conversationId": conversationId, "roster": peerId], "roster"),
            ("enableGroup", ["conversationId": conversationId, "roster": [peerId, 5]], "roster"),
            ("addGroupMember", ["conversationId": conversationId, "userId": peerId, "selfUserId": selfId, "displayNames": [peerId: 1]], "displayNames"),
            ("markVerified", ["peerUserId": peerId, "selfUserId": selfId], "deviceId"),
            ("acceptIdentityChange", ["peerUserId": 5, "deviceId": deviceId, "selfUserId": selfId], "peerUserId"),
            ("backupCreate", [:], "userId"),
            ("backupRotate", ["userId": true], "userId"),
            // Android parity: a missing blobsJson reports field "blobs".
            ("backupRestore", ["userId": selfId], "blobs"),
            ("attachmentUpload", ["localId": "l", "url": "https://x.invalid/", "authHeader": "h", "authValue": "v"], "recipientsJson"),
            ("attachmentFetch", ["localId": "l", "url": 1], "url"),
        ]
        for (method, options, field) in cases {
            let result = invoke(method, options)
            assertInvalidArgument(result, field: field, inline: true, "\(method) \(options)")
        }
        assertNoDialog(since: baseline, "dedicated methods with bad arguments")
    }

    func testNeverProvisioningReadsResolveJson() {
        let before = resolvedJSON(invoke("call", ["__cmd": "e2ee_is_provisioned"]), "is_provisioned (before)")
        XCTAssertTrue(before == "true" || before == "false", "is_provisioned resolves a bare JSON bool, got \(String(describing: before))")
        let provisioned = before == "true"

        let statusText = resolvedJSON(invoke("call", ["__cmd": "e2ee_status"]), "status")
        let status = statusText.flatMap(jsonValue) as? [String: Any]
        XCTAssertNotNil(status, "status resolves a JSON object, got \(String(describing: statusText))")
        if let status = status {
            XCTAssertTrue(isJSONBool(status["enabled"]), "status.enabled")
            XCTAssertTrue(isJSONBool(status["published"]), "status.published")
            XCTAssertTrue(status["protocol_version"] is NSNumber, "status.protocol_version")
            XCTAssertTrue(status["device_id"] is NSNull || status["device_id"] is String, "status.device_id")
            if !provisioned {
                XCTAssertEqual((status["enabled"] as? NSNumber)?.boolValue, false)
                XCTAssertTrue(status["device_id"] is NSNull)
            }
        }

        let modeText = resolvedJSON(invoke("call", ["__cmd": "e2ee_send_mode", "peerUserId": peerId]), "send_mode")
        let mode = (modeText.flatMap(jsonValue) as? [String: Any])?["mode"] as? String
        XCTAssertTrue(
            ["encrypt", "blocked", "plaintext", "peer_downgraded"].contains(mode ?? ""),
            "send_mode resolves {mode}, got \(String(describing: modeText))"
        )
        if !provisioned {
            XCTAssertEqual(mode, "plaintext")
        }

        // None of the three may have provisioned the store.
        let after = resolvedJSON(invoke("call", ["__cmd": "e2ee_is_provisioned"]), "is_provisioned (after)")
        XCTAssertEqual(after, pin(before, wrong: provisioned ? "false" : "true"))
    }

    /// Positive control for `assertNoDialog`: a real consent alert, put up
    /// through the same shared presenter the engine uses, IS detected (and is
    /// then cancelled, which answers false and commits nothing).
    func testDialogDetectorSeesARealConsentAlert() {
        let baseline = topIdentity()
        let payload = ConfirmPayload(
            title: "T6 control",
            message: "Lane T6 detector control. Nothing is committed.",
            confirmLabel: "Confirm",
            cancelLabel: "Cancel",
            kind: "info",
            defaultButton: "cancel"
        )
        let answer = Locked<Bool?>(nil)
        let answered = expectation(description: "confirm returned")
        let thread = Thread {
            answer.set(try? NativeConfirmPresenter.shared.confirm(req: payload))
            answered.fulfill()
        }
        thread.stackSize = 8 << 20
        thread.start()

        let appeared = poll(timeout: 15) { NativeConfirmPresenter.shared.presentedAlertForTesting != nil }
        XCTAssertTrue(appeared, "the control alert never came up; the detector cannot be trusted")
        XCTAssertEqual(dialogVisible(since: baseline), pin(true, wrong: false))

        NativeConfirmPresenter.shared.completeForTesting(confirmed: false)
        wait(for: [answered], timeout: 30)
        XCTAssertEqual(answer.value, false)
        XCTAssertTrue(poll(timeout: 10) { !dialogVisible(since: baseline) }, "the control alert did not go away")
    }

    // MARK: - Helpers

    /// Builds the call exactly as handleJSCall does (CapacitorBridge.swift:507-533) and
    /// performs the selector on a serial queue standing in for Capacitor's.
    private func invoke(_ method: String, _ options: [String: Any], file: StaticString = #filePath, line: UInt = #line) -> Invocation {
        let plugin = E2eePlugin()
        let selector = NSSelectorFromString(method + ":")
        guard plugin.responds(to: selector) else {
            // perform() on a missing selector would crash the host, not fail the test.
            XCTFail("plugin has no \(method):", file: file, line: line)
            return Invocation(outcome: Outcome(), settledInline: false)
        }

        let probe = Probe(expectation(description: "\(method) settles"))
        let jsOptions = JSTypes.coerceDictionaryToJSObject(options as NSDictionary, formattingDatesAsStrings: true) ?? [:]
        let made: CAPPluginCall? = CAPPluginCall(
            callbackId: "t6-\(UUID().uuidString)",
            methodName: method,
            options: jsOptions,
            success: { result, _ in probe.resolved(result?.data) },
            error: { error in probe.rejected(error) }
        )
        guard let call = made else {
            XCTFail("CAPPluginCall init returned nil", file: file, line: line)
            return Invocation(outcome: Outcome(), settledInline: false)
        }

        let inline = Locked(false)
        let handoff = Handoff(value: (plugin, call))
        bridgeQueue.async {
            _ = handoff.value.0.perform(selector, with: handoff.value.1)
            inline.set(probe.snapshot.count > 0)
        }
        wait(for: [probe.settled], timeout: 30)
        // The method has returned on the bridge queue.
        bridgeQueue.sync {}
        // A stray second settle from a hand-off would land shortly after.
        idle(0.1)
        return Invocation(outcome: probe.snapshot, settledInline: inline.value)
    }

    private func assertInvalidArgument(
        _ result: Invocation,
        field: String,
        inline: Bool?,
        _ context: String,
        file: StaticString = #filePath,
        line: UInt = #line
    ) {
        let outcome = result.outcome
        XCTAssertEqual(outcome.resolves.count, 0, "\(context): resolved instead of rejecting", file: file, line: line)
        XCTAssertEqual(outcome.count, 1, "\(context): settles exactly once", file: file, line: line)
        guard let reject = outcome.rejects.first else {
            return
        }
        let expectedField = pin(field, wrong: field + "_wrong")
        // Byte for byte the message CapacitorTransport.#rethrow parses.
        XCTAssertEqual(reject.message, "{\"type\":\"invalid_argument\",\"field\":\"\(expectedField)\"}", context, file: file, line: line)
        let parsed = jsonValue(reject.message) as? [String: Any]
        XCTAssertEqual(parsed?["type"] as? String, "invalid_argument", context, file: file, line: line)
        XCTAssertEqual(parsed?["field"] as? String, expectedField, context, file: file, line: line)
        XCTAssertEqual(parsed?.count, 2, context, file: file, line: line)
        // Android parity: the JSON is the message; no code, no data.
        XCTAssertNil(reject.code, context, file: file, line: line)
        XCTAssertNil(reject.data, context, file: file, line: line)
        if let inline = inline {
            XCTAssertEqual(result.settledInline, inline, "\(context): refused before any hand-off", file: file, line: line)
        }
    }

    /// The `json` string of a single `{json}` resolve, or nil (and a failure).
    private func resolvedJSON(_ result: Invocation, _ context: String, file: StaticString = #filePath, line: UInt = #line) -> String? {
        let outcome = result.outcome
        XCTAssertEqual(outcome.rejects.map { $0.message }, [], "\(context): rejected", file: file, line: line)
        XCTAssertEqual(outcome.resolves.count, 1, "\(context): settles exactly once", file: file, line: line)
        guard let data = outcome.resolves.first else {
            return nil
        }
        XCTAssertEqual(data.keys.sorted(), pin(["json"], wrong: ["json", "x"]), context, file: file, line: line)
        guard let json = data["json"] as? String else {
            XCTFail("\(context): json is not a string", file: file, line: line)
            return nil
        }
        XCTAssertNotNil(jsonValue(json), "\(context): json is not valid JSON", file: file, line: line)
        return json
    }

    private func topIdentity() -> ObjectIdentifier? {
        NativeConfirmPresenter.topMostViewController().map { ObjectIdentifier($0) }
    }

    /// Main thread. Any consent alert of the shared presenter, any alert at the
    /// top, or any other controller presented since `baseline`.
    private func dialogVisible(since baseline: ObjectIdentifier?) -> Bool {
        if NativeConfirmPresenter.shared.presentedAlertForTesting != nil {
            return true
        }
        guard let top = NativeConfirmPresenter.topMostViewController() else {
            return false
        }
        return top is UIAlertController || ObjectIdentifier(top) != baseline
    }

    /// Main thread. Waits long enough for an alert hop to main and its
    /// presentation animation, then checks; cleans up anything it finds.
    private func assertNoDialog(since baseline: ObjectIdentifier?, _ context: String, file: StaticString = #filePath, line: UInt = #line) {
        idle(2)
        let visible = dialogVisible(since: baseline)
        if visible {
            NativeConfirmPresenter.shared.declineAll()
            RecoverySheet.teardown()
            MainActor.assumeIsolated {
                let top = NativeConfirmPresenter.topMostViewController()
                top?.presentingViewController?.dismiss(animated: false)
            }
        }
        XCTAssertEqual(visible, pin(false, wrong: true), "\(context): a dialog or sheet was presented", file: file, line: line)
    }

    /// Main thread. Lets the main run loop (and so the main queue) run.
    private func idle(_ seconds: TimeInterval) {
        let never = XCTestExpectation(description: "idle")
        never.isInverted = true
        _ = XCTWaiter.wait(for: [never], timeout: seconds)
    }

    /// Main thread. True as soon as `condition` holds, false at the timeout.
    private func poll(timeout: TimeInterval, _ condition: () -> Bool) -> Bool {
        let deadline = Date(timeIntervalSinceNow: timeout)
        while Date() < deadline {
            if condition() {
                return true
            }
            idle(0.05)
        }
        return condition()
    }
}
