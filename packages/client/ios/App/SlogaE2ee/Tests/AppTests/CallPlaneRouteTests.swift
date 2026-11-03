// CallPlaneRouteTests.swift: gate G9, the call plane through a real
// CAPPluginCall (iOS call E2EE phase 2, W3 lane L3s; W2 Stage 5 audit M1,
// "W3 MUST" 6). E2eePlugin.swift's `.call` route (runCallPlane on the call
// worker) and its dedicated `callConfirmDowngrade` method.
//
// What these tests pin:
//   1. `e2ee_call_commit_won` refuses a `wonEpoch` that is not a whole JSON
//      number in i64 range (a fraction, a string, a boolean, NaN, beyond
//      i64, absent) as `invalid_argument{wonEpoch}`: never rounded, never
//      coerced to 0, never a trap.
//   2. `e2ee_mls_replenish` refuses a `serverRemaining` that is negative,
//      fractional, NaN, infinite, beyond u64, a string, a boolean or absent
//      as `invalid_argument{serverRemaining}`: never wrapped or truncated,
//      never a trap.
//   3. `e2ee_call_non_enrolled` refuses a missing or mistyped
//      `sfuParticipants` as `invalid_argument{sfuParticipants}`: a missing
//      list must not read as "nobody is live".
//   4. `callConfirmDowngrade` refuses a missing or mistyped groupId,
//      sfuParticipants or displayNames as `invalid_argument{<jsName>}` on
//      the bridge queue, before any hand-off, and shows no dialog: a missing
//      list or map must not default to empty.
//   5. `callConfirmDowngrade` with valid arguments on the app's real,
//      UNPROVISIONED store settles exactly once with the core's
//      `mls_group_not_found` reject for that group, shows no dialog, and
//      leaves the store unprovisioned: nothing exists to confirm, so nothing
//      is armed and nothing resolves.
//   6. Through the real uniffi ABI on a temp store: the announce gate is
//      UNARMED (`mls_not_confirmed`) until a confirm; a declined confirm
//      rejects `declined` and arms nothing; a confirmed one returns (unit,
//      which the plugin maps to `{json:"null"}`) and arms the announce;
//      an unknown group rejects `mls_group_not_found` without a prompt.
//
// What is NOT reached here (reported, not asserted): the plugin's own
// SUCCESS resolve `{json:"null"}` of callConfirmDowngrade. The plugin always
// runs on `E2eeRuntime.shared.engine()`, i.e. the app's REAL store, which has
// no test seam, and a success needs a provisioned store with a call group.
// Provisioning the Simulator's real store is exactly what these suites must
// not do, so the success is pinned one layer down (6) and the resolve
// literal stays covered by source review only. Likewise the plugin's
// "unarmed" reject (`crypto_failure` before `E2eePlugin.arm()`): the host app
// arms the plugin at launch and nothing can disarm it in-process, so every
// reject below is also evidence that the call got PAST the arm check (an
// unarmed plugin would answer `crypto_failure`, not `invalid_argument`).
//
// Store hygiene: the plugin tests send valid values only where the core
// refuses on an unprovisioned store without opening it
// (`with_engine_if_provisioned`), and every bad value must be refused before
// any engine method runs. The engine test runs on a fresh temp directory,
// which tearDown removes. tearDown asserts the app's real store
// (Application Support/e2ee) still holds no store file after every test.
// The engine test creates the production wrap-key item when it is missing,
// so it runs on the Simulator only and removes the item again only when the
// test created it (as RelayTests does).
//
// Known-bad controls: the plugin tests are proven against mutant copies of
// E2eePlugin.swift (coerce instead of reject, default a missing list, swallow
// the core's reject, trap on a negative). The two checks no plugin mutant
// reaches have their own switches below; each must make its tests fail.
import AcutestE2eeBindings
import Capacitor
import Foundation
import Security
import UIKit
import XCTest
@testable import SlogaE2ee

/// false in the checked-in file. true: the engine test's confirm answers
/// the opposite of what each step expects.
private let l3sEngineControl = false

/// false in the checked-in file. true: the real-store probe looks at a temp
/// directory with a planted `store.db`, so every tearDown must fail.
private let l3sStoreProbeControl = false

/// ULID-shaped ids and a 64-hex call group id, so a reject is about the
/// argument under test and not about a malformed id.
private let groupId = String(repeating: "c3", count: 32)
private let peerId = "01J9Z3K4M5N6P7Q8R9S0T1V2W3"
private let selfId = "01J9Z3K4M5N6P7Q8R9S0T1V2W4"
private let testChannelId = "01J9Z8Y7X6W5V4T3S2R1Q0P9C1"

/// The production wrap-key identity (e2ee-core ios_keychain.rs PRODUCTION).
private enum WrapItem {
    static let service = "gg.sloga.app.e2ee"
    static let account = "e2ee-master-wrap"
    static let accessGroup = "M6UUDLK2XQ.gg.sloga.app.e2ee"
}

private struct L3sFailure: Error, CustomStringConvertible {
    let description: String
}

// MARK: - Shared helpers (nonisolated: some run on background threads)

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

    func update<R>(_ body: (inout Value) -> R) -> R {
        lock.lock()
        defer { lock.unlock() }
        return body(&stored)
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
    /// Settled before the plugin method returned on the bridge queue: the
    /// call was refused without handing anything to another thread.
    let settledInline: Bool
}

private func jsonObject(_ text: String) -> [String: Any]? {
    guard let data = text.data(using: .utf8) else {
        return nil
    }
    return (try? JSONSerialization.jsonObject(with: data, options: [])) as? [String: Any]
}

/// A thrown engine error as the reject JSON the plugin would send.
private func rejectType(_ error: Error) -> String? {
    jsonObject(rejectJson(for: error))?["type"] as? String
}

// MARK: - Store probes

/// The files whose presence makes a directory provisioned (e2ee-core
/// store.rs `is_provisioned`). A pure filesystem check.
private func provisioningFiles(in dir: URL) -> [String] {
    ["store.db", "master.key", "restore.pending"].filter {
        FileManager.default.fileExists(atPath: dir.appendingPathComponent($0).path)
    }
}

/// The app's real store directory, located the way
/// `E2eeStore.prepareStoreDirectory` does but without creating anything.
private func realStoreDirectory() -> URL? {
    FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first?
        .appendingPathComponent("e2ee", isDirectory: true)
        .standardizedFileURL
}

private func wrapItemQuery() -> [String: Any] {
    [
        kSecClass as String: kSecClassGenericPassword,
        kSecAttrService as String: WrapItem.service,
        kSecAttrAccount as String: WrapItem.account,
        kSecAttrAccessGroup as String: WrapItem.accessGroup,
        kSecAttrSynchronizable as String: kSecAttrSynchronizableAny,
    ]
}

/// errSecSuccess when the wrap item exists, errSecItemNotFound when not.
/// Attributes only, never the secret.
private func wrapItemStatus() -> OSStatus {
    var query = wrapItemQuery()
    query[kSecMatchLimit as String] = kSecMatchLimitOne
    query[kSecReturnAttributes as String] = true
    var out: CFTypeRef?
    return SecItemCopyMatching(query as CFDictionary, &out)
}

// MARK: - Engine fakes (the real uniffi ABI; never UIKit)

/// Answers each consent request as scripted and counts the requests.
private final class ScriptedConfirm: NativeConfirm, @unchecked Sendable {
    private let state = Locked<(answer: Bool, prompts: Int)>((false, 0))

    func answer(_ value: Bool) {
        state.update { $0.answer = value }
    }

    var prompts: Int {
        state.value.prompts
    }

    func confirm(req: ConfirmPayload) throws -> Bool {
        let answer: Bool = state.update { current in
            current.prompts += 1
            return current.answer
        }
        return answer
    }
}

private final class IgnoringKeysChanged: NativeKeysChanged, @unchecked Sendable {
    func keysChanged(groupId: String, epoch: Int64) throws {}
}

/// What one engine scenario observed; built off main, asserted on main.
private struct ConfirmReport {
    var createdGroup: String?
    var announceBefore: String?
    var declinedResult: String?
    var promptsAfterDecline = -1
    var announceAfterDecline: String?
    var confirmedResult: String?
    var promptsAfterConfirm = -1
    var announceAfterConfirmIsObject = false
    var unknownGroupResult: String?
    var promptsAfterUnknown = -1
}

/// "ok", or the reject type the plugin would send for the thrown error.
private func outcomeType(_ body: () throws -> Void) -> String {
    do {
        try body()
        return "ok"
    } catch {
        return rejectType(error) ?? "<unparsed>"
    }
}

// MARK: - Tests

final class CallPlaneRouteTests: XCTestCase {
    /// Stand-in for Capacitor's serial "bridge" queue (CapacitorBridge.swift:131).
    private let bridgeQueue = DispatchQueue(label: "l3s.bridge")
    private var storeDirs: [URL] = []
    private var plantedProbeDir: URL?
    private var wrapItemExisted = true
    private var builtEngine = false

    override func setUpWithError() throws {
        try super.setUpWithError()
        #if targetEnvironment(simulator)
        let status = wrapItemStatus()
        guard status == errSecSuccess || status == errSecItemNotFound else {
            throw L3sFailure(description: "could not look up the wrap item (OSStatus \(status))")
        }
        wrapItemExisted = status == errSecSuccess
        #endif
    }

    override func tearDownWithError() throws {
        // If a broken build ever let a refused call reach a consent prompt,
        // decline it so nothing can be committed.
        NativeConfirmPresenter.shared.declineAll()

        for dir in storeDirs {
            try? FileManager.default.removeItem(at: dir)
            XCTAssertFalse(FileManager.default.fileExists(atPath: dir.path), "a temp store was not removed")
        }
        storeDirs = []

        #if targetEnvironment(simulator)
        if builtEngine && !wrapItemExisted {
            let status = SecItemDelete(wrapItemQuery() as CFDictionary)
            XCTAssertTrue(
                status == errSecSuccess || status == errSecItemNotFound,
                "could not remove the wrap item this test created (OSStatus \(status))")
        }
        #endif
        builtEngine = false

        // The app's real store must still hold no store file.
        if let real = probedRealStore() {
            XCTAssertEqual(provisioningFiles(in: real), [], "the app's real store holds store files after the test")
        } else {
            XCTFail("no Application Support directory to check the real store in")
        }
        if let planted = plantedProbeDir {
            try? FileManager.default.removeItem(at: planted)
            plantedProbeDir = nil
        }
        try super.tearDownWithError()
    }

    // MARK: 1. wonEpoch

    func testCommitWonRefusesAWonEpochThatIsNotAWholeI64() {
        let values: [Any?] = [
            nil,
            NSNull(),
            1.5,
            -0.5,
            NSNumber(value: 2.000_001),
            "3",
            "1.5",
            true,
            false,
            NSNumber(value: Double.nan),
            NSNumber(value: Double.infinity),
            NSNumber(value: UInt64.max), // beyond i64
            NSNumber(value: 1e19), // beyond i64, as a double
            [3],
            ["epoch": 3],
        ]
        for value in values {
            var options: [String: Any] = ["__cmd": "e2ee_call_commit_won", "groupId": groupId]
            options["wonEpoch"] = value
            let result = invoke("call", options)
            assertInvalidArgument(result, field: "wonEpoch", inline: nil, "wonEpoch: \(String(describing: value))")
        }
    }

    // MARK: 2. serverRemaining

    func testMlsReplenishRefusesAServerRemainingThatIsNotAU64() {
        let values: [Any?] = [
            nil,
            NSNull(),
            -1,
            NSNumber(value: -1.0), // a WebKit-shaped double
            NSNumber(value: Int64.min),
            1.5,
            0.25,
            NSNumber(value: Double.nan),
            NSNumber(value: Double.infinity),
            NSNumber(value: -Double.infinity),
            NSNumber(value: 1e20), // beyond u64
            "5",
            true,
            false,
            [5],
        ]
        for value in values {
            var options: [String: Any] = ["__cmd": "e2ee_mls_replenish", "userId": selfId]
            options["serverRemaining"] = value
            let result = invoke("call", options)
            assertInvalidArgument(result, field: "serverRemaining", inline: nil, "serverRemaining: \(String(describing: value))")
        }
    }

    // MARK: 3. sfuParticipants on the call mux

    func testNonEnrolledRefusesAMissingOrMistypedSfuParticipants() {
        let values: [Any?] = [
            nil,
            NSNull(),
            peerId,
            [5],
            [peerId, 5],
            [peerId, NSNull()],
            [peerId: "Peer"],
            true,
            5,
        ]
        for value in values {
            var options: [String: Any] = ["__cmd": "e2ee_call_non_enrolled", "groupId": groupId]
            options["sfuParticipants"] = value
            let result = invoke("call", options)
            assertInvalidArgument(result, field: "sfuParticipants", inline: nil, "sfuParticipants: \(String(describing: value))")
        }
    }

    // MARK: 4. callConfirmDowngrade arguments

    func testCallConfirmDowngradeRefusesBadArgumentsBeforeAnyHandOffAndShowsNoDialog() {
        let baseline = topIdentity()
        let names: [String: Any] = [peerId: "Peer"]
        let sfu: [Any] = [peerId, selfId]
        let cases: [([String: Any], String)] = [
            ([:], "groupId"),
            (["sfuParticipants": sfu, "displayNames": names], "groupId"),
            (["groupId": NSNull(), "sfuParticipants": sfu, "displayNames": names], "groupId"),
            (["groupId": 5, "sfuParticipants": sfu, "displayNames": names], "groupId"),
            (["groupId": [groupId], "sfuParticipants": sfu, "displayNames": names], "groupId"),
            (["groupId": groupId, "displayNames": names], "sfuParticipants"),
            (["groupId": groupId], "sfuParticipants"),
            (["groupId": groupId, "sfuParticipants": NSNull(), "displayNames": names], "sfuParticipants"),
            (["groupId": groupId, "sfuParticipants": peerId, "displayNames": names], "sfuParticipants"),
            (["groupId": groupId, "sfuParticipants": [peerId, 5], "displayNames": names], "sfuParticipants"),
            (["groupId": groupId, "sfuParticipants": names, "displayNames": names], "sfuParticipants"),
            (["groupId": groupId, "sfuParticipants": sfu], "displayNames"),
            (["groupId": groupId, "sfuParticipants": sfu, "displayNames": NSNull()], "displayNames"),
            (["groupId": groupId, "sfuParticipants": sfu, "displayNames": [peerId]], "displayNames"),
            (["groupId": groupId, "sfuParticipants": sfu, "displayNames": "Peer"], "displayNames"),
            (["groupId": groupId, "sfuParticipants": sfu, "displayNames": [peerId: 1]], "displayNames"),
            (["groupId": groupId, "sfuParticipants": [String](), "displayNames": [peerId: NSNull()]], "displayNames"),
        ]
        for (options, field) in cases {
            let result = invoke("callConfirmDowngrade", options)
            assertInvalidArgument(result, field: field, inline: true, "callConfirmDowngrade \(options)")
        }
        assertNoDialog(since: baseline, "callConfirmDowngrade with bad arguments")
    }

    // MARK: 5. callConfirmDowngrade on the unprovisioned real store

    func testCallConfirmDowngradeOnTheUnprovisionedRealStoreRejectsGroupNotFoundWithNoDialog() throws {
        guard let real = realStoreDirectory() else {
            XCTFail("no Application Support directory")
            return
        }
        guard provisioningFiles(in: real).isEmpty else {
            throw XCTSkip("the app's real store is provisioned: this test's premise (nothing to confirm) does not hold")
        }
        let baseline = topIdentity()
        let result = invoke(
            "callConfirmDowngrade",
            ["groupId": groupId, "sfuParticipants": [peerId, selfId], "displayNames": [peerId: "Peer"]]
        )
        let outcome = result.outcome
        XCTAssertEqual(outcome.resolves.count, 0, "[5a] resolved with nothing confirmed: \(outcome.resolves)")
        XCTAssertEqual(outcome.count, 1, "[5b] settles exactly once")
        XCTAssertFalse(result.settledInline, "[5c] valid arguments were refused on the bridge queue")
        if let reject = outcome.rejects.first {
            let parsed = jsonObject(reject.message)
            XCTAssertEqual(parsed?["type"] as? String, "mls_group_not_found", "[5d] \(reject.message)")
            XCTAssertEqual(parsed?["group_id"] as? String, groupId, "[5e] \(reject.message)")
            XCTAssertEqual(parsed?.count, 2, "[5f] \(reject.message)")
            XCTAssertNil(reject.code, "[5g] Android parity: the JSON is the message")
            XCTAssertNil(reject.data, "[5h] Android parity: no data")
        }
        assertNoDialog(since: baseline, "[5i] callConfirmDowngrade on a fresh store")

        // End to end through the plugin: the store is still not provisioned.
        let provisioned = invoke("call", ["__cmd": "e2ee_is_provisioned"]).outcome
        XCTAssertEqual(provisioned.rejects.map { $0.message }, [], "[5j] is_provisioned rejected")
        XCTAssertEqual(provisioned.resolves.first?["json"] as? String, "false", "[5k] the real store was provisioned")
        XCTAssertEqual(provisioningFiles(in: real), [], "[5l] the real store holds store files")
    }

    // MARK: 6. The confirm through uniffi, on a temp store

    func testEngineConfirmArmsTheAnnounceOnlyWhenConfirmedAndRefusesAnUnknownGroup() throws {
        try requireSimulator()
        let dir = FileManager.default.temporaryDirectory
            .appendingPathComponent("L3s-\(UUID().uuidString)", isDirectory: true)
        storeDirs.append(dir)
        builtEngine = true
        let confirm = ScriptedConfirm()
        let declineAnswer = l3sEngineControl ? true : false
        let confirmAnswer = l3sEngineControl ? false : true
        let unknownGroup = String(repeating: "9d", count: 32)

        let report = try offMain("enable + create + confirm") { () throws -> ConfirmReport in
            dispatchPrecondition(condition: .notOnQueue(.main))
            var report = ConfirmReport()
            let engine = try E2eeEngine(storeDir: dir.path, confirm: confirm, keysChanged: IgnoringKeysChanged())
            _ = try engine.enable()
            let created = try engine.callCreate(channelId: testChannelId, userId: selfId, supersedes: nil)
            guard let group = jsonObject(created)?["group_id"] as? String else {
                return report
            }
            report.createdGroup = group
            let empty = "[]"
            let noNames = "{}"
            report.announceBefore = outcomeType { _ = try engine.callAnnounce(groupId: group, userId: selfId) }

            confirm.answer(declineAnswer)
            report.declinedResult = outcomeType {
                try engine.callConfirmDowngrade(groupId: group, sfuParticipantsJson: "[\"\(peerId)\"]", displayNamesJson: noNames)
            }
            report.promptsAfterDecline = confirm.prompts
            report.announceAfterDecline = outcomeType { _ = try engine.callAnnounce(groupId: group, userId: selfId) }

            confirm.answer(confirmAnswer)
            report.confirmedResult = outcomeType {
                try engine.callConfirmDowngrade(groupId: group, sfuParticipantsJson: empty, displayNamesJson: noNames)
            }
            report.promptsAfterConfirm = confirm.prompts
            if let announced = try? engine.callAnnounce(groupId: group, userId: selfId) {
                report.announceAfterConfirmIsObject = jsonObject(announced) != nil
            }

            confirm.answer(true)
            report.unknownGroupResult = outcomeType {
                try engine.callConfirmDowngrade(groupId: unknownGroup, sfuParticipantsJson: empty, displayNamesJson: noNames)
            }
            report.promptsAfterUnknown = confirm.prompts
            return report
        }

        XCTAssertNotNil(report.createdGroup, "[6a] callCreate returned no group_id")
        XCTAssertEqual(report.announceBefore, "mls_not_confirmed", "[6b] the announce gate was not unarmed before any confirm")
        XCTAssertEqual(report.declinedResult, "declined", "[6c] a declined confirm did not reject `declined`")
        XCTAssertEqual(report.promptsAfterDecline, 1, "[6d] the declined confirm did not prompt exactly once")
        XCTAssertEqual(report.announceAfterDecline, "mls_not_confirmed", "[6e] a declined confirm armed the announce")
        XCTAssertEqual(report.confirmedResult, "ok", "[6f] a confirmed confirm did not return (the plugin's {json:\"null\"})")
        XCTAssertEqual(report.promptsAfterConfirm, 2, "[6g] the confirm did not prompt exactly once")
        XCTAssertTrue(report.announceAfterConfirmIsObject, "[6h] a confirmed confirm did not arm the announce")
        XCTAssertEqual(report.unknownGroupResult, "mls_group_not_found", "[6i] an unknown group was not refused")
        XCTAssertEqual(report.promptsAfterUnknown, 2, "[6j] an unknown group reached a prompt")
    }

    // MARK: - Helpers

    private func requireSimulator() throws {
        #if !targetEnvironment(simulator)
        throw XCTSkip("creates the production wrap-key item when it is missing: Simulator only")
        #endif
    }

    /// The real store, or the planted control directory.
    private func probedRealStore() -> URL? {
        guard l3sStoreProbeControl else {
            return realStoreDirectory()
        }
        if plantedProbeDir == nil {
            let dir = FileManager.default.temporaryDirectory
                .appendingPathComponent("L3s-probe-\(UUID().uuidString)", isDirectory: true)
            try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
            FileManager.default.createFile(atPath: dir.appendingPathComponent("store.db").path, contents: Data())
            plantedProbeDir = dir
        }
        return plantedProbeDir
    }

    /// Runs `body` on a dedicated 8 MiB thread and waits for it here. Engine
    /// calls must never run on the main thread, and test methods run on main.
    private func offMain<T>(_ label: String, _ body: @escaping () throws -> T) throws -> T {
        let box = Locked<Result<T, Error>?>(nil)
        let finished = expectation(description: label)
        runOnDedicatedThread(name: "gg.sloga.l3s.engine-tests") {
            let result = Result { try body() }
            box.update { $0 = result }
            finished.fulfill()
        }
        wait(for: [finished], timeout: 60)
        guard let outcome = box.value else {
            throw L3sFailure(description: "\(label) did not finish in 60 s")
        }
        return try outcome.get()
    }

    /// Builds the call exactly as handleJSCall does (CapacitorBridge.swift:507-533)
    /// and performs the selector on a serial queue standing in for Capacitor's.
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
            callbackId: "l3s-\(UUID().uuidString)",
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
            inline.update { $0 = probe.snapshot.count > 0 }
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
        // Byte for byte the message CapacitorTransport.#rethrow parses.
        XCTAssertEqual(reject.message, "{\"type\":\"invalid_argument\",\"field\":\"\(field)\"}", context, file: file, line: line)
        let parsed = jsonObject(reject.message)
        XCTAssertEqual(parsed?["type"] as? String, "invalid_argument", context, file: file, line: line)
        XCTAssertEqual(parsed?["field"] as? String, field, context, file: file, line: line)
        XCTAssertEqual(parsed?.count, 2, context, file: file, line: line)
        // Android parity: the JSON is the message; no code, no data.
        XCTAssertNil(reject.code, context, file: file, line: line)
        XCTAssertNil(reject.data, context, file: file, line: line)
        if let inline = inline {
            XCTAssertEqual(result.settledInline, inline, "\(context): refused before any hand-off", file: file, line: line)
        }
    }

    private func topIdentity() -> ObjectIdentifier? {
        NativeConfirmPresenter.topMostViewController().map { ObjectIdentifier($0) }
    }

    /// Main thread. Any consent alert of the shared presenter, any alert at
    /// the top, or any other controller presented since `baseline`.
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
            MainActor.assumeIsolated {
                let top = NativeConfirmPresenter.topMostViewController()
                top?.presentingViewController?.dismiss(animated: false)
            }
        }
        XCTAssertFalse(visible, "\(context): a dialog was presented", file: file, line: line)
    }

    /// Main thread. Lets the main run loop (and so the main queue) run.
    private func idle(_ seconds: TimeInterval) {
        let never = XCTestExpectation(description: "idle")
        never.isInverted = true
        _ = XCTWaiter.wait(for: [never], timeout: seconds)
    }
}
