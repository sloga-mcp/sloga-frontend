// RelayTests.swift: gate G9, the key-push relay (iOS call E2EE phase 2,
// C-W2-9, lane L2j): KeysChangedRelay.swift, and the call worker in
// Support.swift.
//
// What these tests pin:
//   1. `KeysChangedRelay.shared` delivers on the main thread only, through
//      one async hop: the core's calling thread gets control back at once,
//      even while main is busy, and the attached plugin then gets exactly
//      `callKeysChanged` / {group_id, epoch} on main, once.
//   2. The relay holds the plugin weakly: a released plugin is really gone
//      (nothing on the relay's side keeps it alive), and a later delivery
//      reaches nobody without crashing.
//   3. `attach` called from a background thread takes effect on main, in
//      main-queue order, and its hop does not keep a dropped plugin alive.
//   4. End to end through uniffi's generated callback layer: a real
//      E2eeEngine over a temp store, built with a NativeKeysChanged that
//      THROWS (a foreign Swift error, and the declared KeysChangedError),
//      still answers `callCreate` with Ok, twice (no abort and no wedged
//      engine). Every conformance sees exactly one (group_id, 0) push per
//      create, on the calling thread, before `callCreate` returns.
//   5. Engine calls never run on main (the dispatch helper asserts it and
//      the scenario records the calling thread).
//   6. `callWorker` and `engineWorker` are two distinct serial 8 MiB
//      workers, and a blocked engine worker does not hold up the call
//      worker.
//
// Store hygiene: engines run only on fresh temp directories, which tearDown
// removes. No engine is ever built on the app's REAL store
// (Application Support/e2ee), and tearDown asserts that store still holds
// no store file after every test. The engine tests create the production
// wrap-key item when it is missing, so they run on the Simulator only and
// remove the item again only when the test created it (as
// RecoverySheetTests does).
//
// Limit: the relay's plugin slot is private, so these tests can neither
// read nor restore it. Each relay test leaves it pointing at a plugin that
// is released by the end of the test, so if the app's own E2eePlugin was
// attached at launch, it is no longer attached after this suite.
//
// Every check runs against a known-bad subject too: `l2jControl = true`
// swaps each subject for the one a broken build would produce (a relay that
// delivers on a background queue, a relay that retains the plugin, an
// attach that writes at once or retains through its hop, the wrong expected
// epoch, the call worker replaced by the engine worker), and every test
// must then fail.
import AcutestE2eeBindings
import Capacitor
import Darwin
import Foundation
import Security
import XCTest
@testable import SlogaE2ee

private let l2jControl = false

/// The real subject normally, the known-bad one in the control run.
private func subject<T>(_ real: @autoclosure () throws -> T, bad: @autoclosure () throws -> T) rethrows -> T {
    try l2jControl ? bad() : real()
}

/// Literals, not read from the module, so a renamed event or key is caught.
private let keysChangedEvent = "callKeysChanged"
private let eightMiB = 8 * 1024 * 1024

/// A call-group-shaped id (64 lowercase hex) and an epoch above 2^32, so a
/// truncating conversion on the way to the plugin is caught.
private let relayGroupId = String(repeating: "5a", count: 32)
private let relayEpoch: Int64 = (1 << 40) + 7

/// ULID-shaped ids, as the page sends them.
private let testChannelId = "01J9Z8Y7X6W5V4T3S2R1Q0P9C1"
private let testUserId = "01J9Z8Y7X6W5V4T3S2R1Q0P9N8"

/// The production wrap-key identity (e2ee-core ios_keychain.rs PRODUCTION).
/// A temp-dir engine wraps its master key with this item, creating it if it
/// is missing.
private enum WrapItem {
    static let service = "gg.sloga.app.e2ee"
    static let account = "e2ee-master-wrap"
    static let accessGroup = "M6UUDLK2XQ.gg.sloga.app.e2ee"
}

private struct L2jFailure: Error, CustomStringConvertible {
    let description: String
}

// MARK: - Shared helpers (nonisolated: some run on background threads)

/// Hands a closure or a non-Sendable value to another thread; every value
/// the tests share across threads sits behind `Locked`.
private struct UncheckedSendable<Value>: @unchecked Sendable {
    let value: Value
}

private final class Locked<Value>: @unchecked Sendable {
    private let lock = NSLock()
    private var value: Value

    init(_ value: Value) {
        self.value = value
    }

    @discardableResult
    func update<R>(_ body: (inout Value) -> R) -> R {
        lock.lock()
        defer { lock.unlock() }
        return body(&value)
    }

    var snapshot: Value {
        update { $0 }
    }
}

/// A weak reference readable from any thread.
private final class WeakRef: @unchecked Sendable {
    private let lock = NSLock()
    private weak var object: AnyObject?

    func set(_ value: AnyObject) {
        lock.lock()
        object = value
        lock.unlock()
    }

    var isGone: Bool {
        lock.lock()
        defer { lock.unlock() }
        return object == nil
    }
}

/// One event a plugin was asked to emit.
private struct Emitted: Equatable {
    let event: String
    let keys: [String]
    let groupId: String?
    let epoch: Int64?
    /// The epoch is an NSNumber holding a signed 64-bit integer ("q").
    let epochIsInt64: Bool
    let onMain: Bool
    /// nil through `notifyListeners(_:data:)`; the flag when the
    /// `retainUntilConsumed` variant was used instead.
    let retainUntilConsumed: Bool?
}

private func emitted(_ event: String, _ data: [String: Any]?, retain: Bool?) -> Emitted {
    let payload = data ?? [:]
    let number = payload["epoch"] as? NSNumber
    return Emitted(
        event: event,
        keys: payload.keys.sorted(),
        groupId: payload["group_id"] as? String,
        epoch: number?.int64Value,
        epochIsInt64: number.map { String(cString: $0.objCType) == "q" } ?? false,
        onMain: Thread.isMainThread,
        retainUntilConsumed: retain
    )
}

/// What the page must receive for one push: the event, the two keys and
/// nothing else, on main, through the plain (non-retaining) emit.
private func expectedEmit(epoch: Int64) -> Emitted {
    Emitted(
        event: keysChangedEvent,
        keys: ["epoch", "group_id"],
        groupId: relayGroupId,
        epoch: epoch,
        epochIsInt64: true,
        onMain: true,
        retainUntilConsumed: nil
    )
}

/// A Capacitor plugin that records what it is asked to emit, and where.
private final class RecordingPlugin: CAPPlugin, @unchecked Sendable {
    private let log: Locked<[Emitted]>

    init(log: Locked<[Emitted]>) {
        self.log = log
        super.init()
    }

    override func notifyListeners(_ eventName: String, data: [String: Any]?) {
        let entry = emitted(eventName, data, retain: nil)
        log.update { $0.append(entry) }
    }

    override func notifyListeners(_ eventName: String, data: [String: Any]?, retainUntilConsumed retain: Bool) {
        let entry = emitted(eventName, data, retain: retain)
        log.update { $0.append(entry) }
    }
}

/// The emit a broken relay would do, for the control subjects.
private func emitDirectly(_ plugin: CAPPlugin?, _ groupId: String, _ epoch: Int64) {
    plugin?.notifyListeners(keysChangedEvent, data: ["group_id": groupId, "epoch": NSNumber(value: epoch)])
}

/// What the core's calling thread observed around one `keysChanged`.
private struct CallSite {
    var finished = false
    var ranOnMain = true
    var threw = false
    /// Events delivered while main was still blocked (0.2 s after the
    /// call returned, so a delivery on any other queue has time to land).
    var deliveredWhileMainBlocked = -1
}

/// Runs `body` on a new 8 MiB thread while main is BLOCKED on a semaphore
/// (no run loop), so no main-queue block can run until `body` returns.
/// False when `body` did not finish within `timeout` (e.g. a sync hop to
/// main deadlocked).
private func runOffMainWhileMainIsBlocked(timeout: TimeInterval = 10, _ body: @escaping () -> Void) -> Bool {
    dispatchPrecondition(condition: .onQueue(.main))
    let done = DispatchSemaphore(value: 0)
    let work = UncheckedSendable(value: body)
    runOnDedicatedThread(name: "gg.sloga.l2j.engine-like") {
        work.value()
        done.signal()
    }
    return done.wait(timeout: .now() + timeout) == .success
}

/// Calls `relay.keysChanged` the way the core does: on an engine thread,
/// from inside a command, while main is busy.
private func deliverFromAnEngineThread(
    _ relay: KeysChangedRelay,
    groupId: String,
    epoch: Int64,
    observing log: Locked<[Emitted]>
) -> CallSite {
    let site = Locked(CallSite())
    let finished = runOffMainWhileMainIsBlocked {
        let onMain = Thread.isMainThread
        var threw = false
        do {
            try relay.keysChanged(groupId: groupId, epoch: epoch)
        } catch {
            threw = true
        }
        Thread.sleep(forTimeInterval: 0.2)
        let delivered = log.snapshot.count
        site.update {
            $0.ranOnMain = onMain
            $0.threw = threw
            $0.deliveredWhileMainBlocked = delivered
        }
    }
    var result = site.snapshot
    result.finished = finished
    return result
}

/// Lets main run for `seconds`, so anything queued gets its chance.
private func spinMain(_ seconds: TimeInterval) {
    dispatchPrecondition(condition: .onQueue(.main))
    let end = Date(timeIntervalSinceNow: seconds)
    while Date() < end {
        _ = RunLoop.current.run(mode: .default, before: end)
    }
}

/// Runs main's run loop until `condition` holds; false on timeout.
private func spinMain(until condition: () -> Bool, timeout: TimeInterval) -> Bool {
    dispatchPrecondition(condition: .onQueue(.main))
    let deadline = Date(timeIntervalSinceNow: timeout)
    while !condition() {
        if Date() >= deadline {
            return false
        }
        _ = RunLoop.current.run(mode: .default, before: Date(timeIntervalSinceNow: 0.01))
    }
    return true
}

// MARK: - Store probes

/// The store files whose presence makes a directory provisioned (e2ee-core
/// store.rs `is_provisioned`: DB_FILE, MASTER_KEY_FILE, RESTORE_MARKER_FILE).
/// A pure filesystem check: never opens or creates anything.
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

/// Never consents. Nothing here reaches a confirm-gated method.
private final class DecliningConfirm: NativeConfirm, @unchecked Sendable {
    func confirm(req: ConfirmPayload) throws -> Bool {
        false
    }
}

/// Not a `KeysChangedError`: uniffi takes its "unexpected error" branch.
private struct ForeignSwiftError: Error {}

private struct Push: Equatable {
    let groupId: String
    let epoch: Int64
}

private struct PushSample {
    let push: Push
    let onMain: Bool
    let thread: ObjectIdentifier
}

/// A key-push sink that records every call, then answers as scripted.
private final class ScriptedKeysChanged: NativeKeysChanged, @unchecked Sendable {
    enum Mode {
        case record
        case throwForeignError
        case throwDeclaredError
    }

    private let mode: Mode
    private let seen = Locked<[PushSample]>([])

    init(_ mode: Mode) {
        self.mode = mode
    }

    var samples: [PushSample] {
        seen.snapshot
    }

    func keysChanged(groupId: String, epoch: Int64) throws {
        let sample = PushSample(
            push: Push(groupId: groupId, epoch: epoch),
            onMain: Thread.isMainThread,
            thread: ObjectIdentifier(Thread.current)
        )
        seen.update { $0.append(sample) }
        switch mode {
        case .record:
            return
        case .throwForeignError:
            throw ForeignSwiftError()
        case .throwDeclaredError:
            throw KeysChangedError.Unexpected(reason: "L2j declared")
        }
    }
}

private struct CreateReport {
    var callerOnMain = true
    var callerThread: ObjectIdentifier?
    var filesAfterEnable: [String] = []
    var pushesAfterEnable: [PushSample] = []
    var first: Result<String, Error>?
    var pushesAfterFirst: [PushSample] = []
    var second: Result<String, Error>?
    var pushesAfterSecond: [PushSample] = []
}

/// enable(), then two callCreate on a new engine over `dir` built with
/// `sink`; the engine is released before this returns. Off main only.
private func runCallCreateScenario(dir: URL, sink: ScriptedKeysChanged) throws -> CreateReport {
    dispatchPrecondition(condition: .notOnQueue(.main))
    var report = CreateReport()
    report.callerOnMain = Thread.isMainThread
    report.callerThread = ObjectIdentifier(Thread.current)
    let engine = try E2eeEngine(storeDir: dir.path, confirm: DecliningConfirm(), keysChanged: sink)
    _ = try engine.enable()
    report.filesAfterEnable = provisioningFiles(in: dir)
    report.pushesAfterEnable = sink.samples
    report.first = Result { try engine.callCreate(channelId: testChannelId, userId: testUserId, supersedes: nil) }
    report.pushesAfterFirst = sink.samples
    report.second = Result { try engine.callCreate(channelId: testChannelId, userId: testUserId, supersedes: nil) }
    report.pushesAfterSecond = sink.samples
    return report
}

/// `{group_id, payload: {group_id, channel_id, ...}}` from callCreate.
private func createdIds(_ json: String) -> (groupId: String?, payloadGroupId: String?, payloadChannelId: String?) {
    let object = (try? JSONSerialization.jsonObject(with: Data(json.utf8))) as? [String: Any]
    let payload = object?["payload"] as? [String: Any]
    return (object?["group_id"] as? String, payload?["group_id"] as? String, payload?["channel_id"] as? String)
}

private func isLowerHex64(_ s: String) -> Bool {
    s.count == 64 && s.allSatisfy { "0123456789abcdef".contains($0) }
}

/// A failed engine result as the core's scrubbed reject JSON (never a raw
/// Swift error description).
private func describe(_ result: Result<String, Error>?) -> String {
    switch result {
    case .none:
        return "<not run>"
    case .success:
        return "Ok"
    case .failure(let error):
        return rejectJson(for: error)
    }
}

// MARK: - Worker probes

private struct JobSample {
    let index: Int
    let onMain: Bool
    let pthreadStack: Int
    let threadStack: Int
    let threadName: String?
    let thread: ObjectIdentifier
}

private func probeThread(_ index: Int) -> JobSample {
    JobSample(
        index: index,
        onMain: Thread.isMainThread,
        pthreadStack: pthread_get_stacksize_np(pthread_self()),
        threadStack: Thread.current.stackSize,
        threadName: Thread.current.name,
        thread: ObjectIdentifier(Thread.current)
    )
}

private struct Flight {
    var now = 0
    var max = 0
}

/// One serial executor: submission order, one thread with the given name,
/// never main, never two jobs at once, 8 MiB stacks.
private func serialRunProblems(_ samples: [JobSample], count: Int, name: String, maxInFlight: Int) -> [String] {
    var problems: [String] = []
    if samples.map(\.index) != Array(0..<count) {
        problems.append("jobs did not run in submission order")
    }
    if samples.contains(where: \.onMain) {
        problems.append("a job ran on the main thread")
    }
    if let low = samples.map(\.pthreadStack).min(), low < eightMiB {
        problems.append("pthread stack \(low) < 8 MiB")
    }
    if let low = samples.map(\.threadStack).min(), low < eightMiB {
        problems.append("Thread.stackSize \(low) < 8 MiB")
    }
    let threads = Set(samples.map(\.thread)).count
    if threads != 1 {
        problems.append("jobs ran on \(threads) threads, expected 1")
    }
    if samples.contains(where: { $0.threadName != name }) {
        problems.append("a job ran on a thread not named \(name)")
    }
    if maxInFlight != 1 {
        problems.append("\(maxInFlight) jobs ran at once")
    }
    return problems
}

// MARK: - Tests

final class RelayTests: XCTestCase {
    private var storeDirs: [URL] = []
    private var realStoreFilesBefore: [String] = []
    private var wrapItemExisted = true
    private var builtEngine = false

    override func setUpWithError() throws {
        try super.setUpWithError()
        if let real = realStoreDirectory() {
            realStoreFilesBefore = provisioningFiles(in: real)
        }
        #if targetEnvironment(simulator)
        let status = wrapItemStatus()
        guard status == errSecSuccess || status == errSecItemNotFound else {
            throw L2jFailure(description: "could not look up the wrap item (OSStatus \(status))")
        }
        wrapItemExisted = status == errSecSuccess
        #endif
    }

    override func tearDownWithError() throws {
        // Run any hop a test posted, so it cannot land in the next test.
        spinMain(0.2)

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

        // The app's real store: never opened here, so it must still hold no
        // store file (the Simulator's app store stays unprovisioned).
        if let real = realStoreDirectory() {
            XCTAssertEqual(
                provisioningFiles(in: real), [],
                "the app's real store holds store files after the test (before it: \(realStoreFilesBefore))")
        } else {
            XCTFail("no Application Support directory to check the real store in")
        }
        try super.tearDownWithError()
    }

    // MARK: Helpers

    /// A store directory that does not exist yet; the core creates it.
    private func makeStoreDir() -> URL {
        let dir = FileManager.default.temporaryDirectory
            .appendingPathComponent("L2j-\(UUID().uuidString)", isDirectory: true)
        storeDirs.append(dir)
        return dir
    }

    /// Runs `body` on a dedicated 8 MiB thread and waits for it here. Engine
    /// calls must never run on the main thread, and test methods run on main.
    private func offMain<T>(_ label: String, _ body: @escaping () throws -> T) throws -> T {
        let box = Locked<Result<T, Error>?>(nil)
        let finished = expectation(description: label)
        runOnDedicatedThread(name: "gg.sloga.l2j.engine-tests") {
            let result = Result { try body() }
            box.update { $0 = result }
            finished.fulfill()
        }
        wait(for: [finished], timeout: 60)
        guard let outcome = box.snapshot else {
            throw L2jFailure(description: "\(label) did not finish in 60 s")
        }
        return try outcome.get()
    }

    private func requireSimulator() throws {
        #if !targetEnvironment(simulator)
        throw XCTSkip("creates the production wrap-key item when it is missing: Simulator only")
        #endif
    }

    private func runProbeJobs(
        count: Int,
        submit: (@escaping () -> Void) -> Void
    ) -> (samples: [JobSample], maxInFlight: Int) {
        let samples = Locked<[JobSample]>([])
        let flight = Locked(Flight())
        let done = expectation(description: "probe jobs")
        done.expectedFulfillmentCount = count
        for index in 0..<count {
            submit {
                flight.update { state in
                    state.now += 1
                    state.max = Swift.max(state.max, state.now)
                }
                let sample = probeThread(index)
                samples.update { $0.append(sample) }
                flight.update { $0.now -= 1 }
                done.fulfill()
            }
        }
        wait(for: [done], timeout: 30)
        return (samples.snapshot, flight.snapshot.max)
    }

    // MARK: 1. Delivery on main only

    /// The core calls `keysChanged` on its own thread from inside a command.
    /// The shared relay must give that thread control back at once, even
    /// while main is busy (no sync hop, no blocking), deliver nothing on that
    /// thread or any other queue, and then emit exactly one
    /// `callKeysChanged {group_id, epoch}` on main.
    func testSharedRelayDeliversOnceOnMainWithExactlyGroupIdAndEpoch() {
        let log = Locked<[Emitted]>([])
        let plugin = RecordingPlugin(log: log)
        KeysChangedRelay.attach(plugin)
        let relay: KeysChangedRelay = subject(
            KeysChangedRelay.shared,
            bad: KeysChangedRelay { [weak plugin] groupId, epoch in
                DispatchQueue.global(qos: .userInitiated).async { emitDirectly(plugin, groupId, epoch) }
            })

        let site = deliverFromAnEngineThread(relay, groupId: relayGroupId, epoch: relayEpoch, observing: log)
        XCTAssertTrue(site.finished, "[1a] keysChanged did not return while main was busy")
        XCTAssertFalse(site.ranOnMain, "[1b] the harness called keysChanged on main")
        XCTAssertFalse(site.threw, "[1c] keysChanged threw")
        XCTAssertEqual(
            site.deliveredWhileMainBlocked, 0,
            "[1d] an event was delivered before main ran: not on the main queue")

        XCTAssertTrue(spinMain(until: { !log.snapshot.isEmpty }, timeout: 5), "[1e] nothing was delivered")
        spinMain(0.2)
        XCTAssertEqual(log.snapshot, [expectedEmit(epoch: relayEpoch)], "[1f] not exactly one event, on main, with the pinned payload")
    }

    // MARK: 2. Weak plugin reference

    /// Attach a plugin, drop the last strong reference: it must be gone
    /// (the relay keeps nothing alive), and a later push reaches nobody and
    /// does not crash.
    func testRelayDoesNotRetainThePluginAndAReleasedPluginGetsNothing() {
        let log = Locked<[Emitted]>([])
        let weakPlugin = WeakRef()
        let relay: KeysChangedRelay = autoreleasepool { () -> KeysChangedRelay in
            let plugin = RecordingPlugin(log: log)
            weakPlugin.set(plugin)
            KeysChangedRelay.attach(plugin)
            return subject(
                KeysChangedRelay.shared,
                bad: KeysChangedRelay { groupId, epoch in
                    DispatchQueue.main.async { emitDirectly(plugin, groupId, epoch) }
                })
        }
        XCTAssertTrue(weakPlugin.isGone, "[2a] the released plugin is still alive: something retains it")

        let site = deliverFromAnEngineThread(relay, groupId: relayGroupId, epoch: relayEpoch, observing: log)
        XCTAssertTrue(site.finished, "[2b] keysChanged did not return")
        XCTAssertFalse(site.threw, "[2c] keysChanged threw with no plugin attached")
        spinMain(0.3)
        XCTAssertEqual(log.snapshot, [], "[2d] a released plugin still received the event")
    }

    // MARK: 3. attach from a background thread

    /// `attach` called off main must not write the plugin slot at once: it
    /// takes effect on main, in main-queue order. A push posted BEFORE the
    /// off-main attach therefore still reaches the previous plugin, and one
    /// posted after it reaches the new one; both on main.
    func testAttachFromABackgroundThreadTakesEffectOnMainInQueueOrder() {
        let logA = Locked<[Emitted]>([])
        let logB = Locked<[Emitted]>([])
        let pluginA = RecordingPlugin(log: logA)
        let pluginB = RecordingPlugin(log: logB)
        KeysChangedRelay.attach(pluginA)

        // E1: queued on main now; reads the slot only when it runs.
        XCTAssertNoThrow(try KeysChangedRelay.shared.keysChanged(groupId: relayGroupId, epoch: 1))

        let attachRanOffMain = Locked<Bool?>(nil)
        let boxB = UncheckedSendable(value: pluginB)
        let attachB: () -> Bool = subject(
            {
                runOffMainWhileMainIsBlocked {
                    attachRanOffMain.update { $0 = !Thread.isMainThread }
                    KeysChangedRelay.attach(boxB.value)
                }
            },
            bad: {
                // A write that does not wait for main's queue.
                attachRanOffMain.update { $0 = true }
                KeysChangedRelay.attach(boxB.value)
                return true
            })
        XCTAssertTrue(attachB(), "[3a] attach from a background thread did not return while main was busy")
        XCTAssertEqual(attachRanOffMain.snapshot, true, "[3b] the harness did not attach off main")
        XCTAssertEqual(logA.snapshot.count + logB.snapshot.count, 0, "[3c] an event was delivered before main ran")

        // E2: queued after the attach's hop.
        XCTAssertNoThrow(try KeysChangedRelay.shared.keysChanged(groupId: relayGroupId, epoch: 2))

        XCTAssertTrue(
            spinMain(until: { logA.snapshot.count + logB.snapshot.count >= 2 }, timeout: 5),
            "[3d] not both pushes were delivered")
        spinMain(0.2)
        XCTAssertEqual(
            logA.snapshot, [expectedEmit(epoch: 1)],
            "[3e] the push queued before the off-main attach did not reach the previous plugin: the attach wrote the slot off main")
        XCTAssertEqual(logB.snapshot, [expectedEmit(epoch: 2)], "[3f] the push after the attach did not reach the new plugin on main")
    }

    /// The off-main attach's hop captures the plugin weakly: a plugin dropped
    /// before main runs the hop is gone at once, and nothing crashes.
    func testAttachFromABackgroundThreadDoesNotKeepADroppedPluginAlive() {
        let log = Locked<[Emitted]>([])
        let weakPlugin = WeakRef()
        let goneBeforeMainRan = Locked<Bool?>(nil)
        let attach: (CAPPlugin) -> Void = subject(
            { KeysChangedRelay.attach($0) },
            bad: { plugin in
                // A hop that holds the plugin strongly until main runs it.
                DispatchQueue.main.async { KeysChangedRelay.attach(plugin) }
            })
        let finished = runOffMainWhileMainIsBlocked {
            autoreleasepool {
                let plugin = RecordingPlugin(log: log)
                weakPlugin.set(plugin)
                attach(plugin)
            }
            goneBeforeMainRan.update { $0 = weakPlugin.isGone }
        }
        XCTAssertTrue(finished, "[3g] attach from a background thread did not return while main was busy")
        XCTAssertEqual(goneBeforeMainRan.snapshot, true, "[3h] the attach's hop kept a dropped plugin alive")

        spinMain(0.2)
        XCTAssertNoThrow(try KeysChangedRelay.shared.keysChanged(groupId: relayGroupId, epoch: relayEpoch))
        spinMain(0.3)
        XCTAssertTrue(weakPlugin.isGone, "[3i] the dropped plugin came back to life")
        XCTAssertEqual(log.snapshot, [], "[3j] the dropped plugin received an event")
    }

    // MARK: 4 + 5. End to end through uniffi

    /// enable() then two callCreate on a real engine over a temp store, with
    /// `mode` as the key-push sink. Every create must return Ok with a real
    /// group, the sink must see exactly one (group_id, 0) per create, pushed
    /// on the calling (non-main) thread before callCreate returned.
    private func assertCallCreateSurvivesTheSink(_ mode: ScriptedKeysChanged.Mode, _ tag: String) throws {
        try requireSimulator()
        let dir = makeStoreDir()
        let sink = ScriptedKeysChanged(mode)
        builtEngine = true
        let report = try offMain("\(tag) enable + callCreate x2") { () throws -> CreateReport in
            dispatchPrecondition(condition: .notOnQueue(.main))
            return try runCallCreateScenario(dir: dir, sink: sink)
        }

        XCTAssertFalse(report.callerOnMain, "\(tag) [5a] the engine call ran on main")
        XCTAssertTrue(
            report.filesAfterEnable.contains("master.key"),
            "\(tag) [4a] enable left no master.key (the store probe would not see a provisioned store)")
        XCTAssertEqual(report.pushesAfterEnable.map(\.push), [], "\(tag) [4b] enable pushed a key change")

        guard case .success(let firstJson)? = report.first else {
            XCTFail("\(tag) [4c] the first callCreate did not return Ok: \(describe(report.first))")
            return
        }
        let first = createdIds(firstJson)
        let g1 = try XCTUnwrap(first.groupId, "\(tag) [4d] callCreate returned no group_id")
        XCTAssertTrue(isLowerHex64(g1), "\(tag) [4e] the group id is not 64 lowercase hex")
        XCTAssertEqual(first.payloadGroupId, g1, "\(tag) [4f] the payload names another group")
        XCTAssertEqual(first.payloadChannelId, testChannelId, "\(tag) [4g] the payload names another channel")

        let expectedEpoch: Int64 = subject(0, bad: 1)
        XCTAssertEqual(
            report.pushesAfterFirst.map(\.push), [Push(groupId: g1, epoch: expectedEpoch)],
            "\(tag) [4h] callCreate did not push exactly one (group_id, 0) before returning")

        guard case .success(let secondJson)? = report.second else {
            XCTFail("\(tag) [4i] the engine stopped answering after a push: \(describe(report.second))")
            return
        }
        let g2 = try XCTUnwrap(createdIds(secondJson).groupId, "\(tag) [4j] the second callCreate returned no group_id")
        XCTAssertNotEqual(g1, g2, "\(tag) [4k] two creates returned one group")
        XCTAssertEqual(
            report.pushesAfterSecond.map(\.push),
            [Push(groupId: g1, epoch: expectedEpoch), Push(groupId: g2, epoch: expectedEpoch)],
            "\(tag) [4l] the second create did not push exactly one more (group_id, 0)")
        for sample in report.pushesAfterSecond {
            XCTAssertFalse(sample.onMain, "\(tag) [5b] the core pushed on main")
            XCTAssertEqual(sample.thread, report.callerThread, "\(tag) [4m] the push did not run on the calling thread")
        }
    }

    func testCallCreateIsOkAndPushesEpochZeroToARecordingSink() throws {
        try assertCallCreateSurvivesTheSink(.record, "[record]")
    }

    /// The carry-forward XCTest: an UNDECLARED Swift error from the
    /// conformance goes through uniffi's unexpected-error branch
    /// (`From<UnexpectedUniFFICallbackError>`), not a panic.
    func testCallCreateIsOkWhenTheSinkThrowsAForeignSwiftError() throws {
        try assertCallCreateSurvivesTheSink(.throwForeignError, "[foreign]")
    }

    /// The declared error (`KeysChangedError.Unexpected`) goes through
    /// uniffi's declared-error branch; the core drops it too.
    func testCallCreateIsOkWhenTheSinkThrowsTheDeclaredError() throws {
        try assertCallCreateSurvivesTheSink(.throwDeclaredError, "[declared]")
    }

    // MARK: 6. Two serial workers

    /// The runtime has one call worker and one engine worker: two different
    /// serial executors (one named 8 MiB thread each, FIFO, never main), and
    /// a job on the call worker runs while the engine worker is blocked
    /// (a decrypt burst cannot hold a call commit behind it in FIFO order).
    func testCallWorkerAndEngineWorkerAreDistinctSerialWorkers() {
        let runtime = E2eeRuntime.shared
        let engineWorker = runtime.engineWorker
        let callWorker = subject(runtime.callWorker, bad: runtime.engineWorker)
        XCTAssertTrue(runtime.callWorker === E2eeRuntime.shared.callWorker, "[6a] the call worker is not one shared worker")
        XCTAssertFalse(callWorker === engineWorker, "[6b] the call worker is the engine worker")

        // No-op jobs on the app's real workers; they queue behind any real
        // command, which is why the waits allow 30 s.
        let engineRun = runProbeJobs(count: 50) { engineWorker.submit($0) }
        XCTAssertEqual(
            serialRunProblems(engineRun.samples, count: 50, name: "gg.sloga.e2ee.engine", maxInFlight: engineRun.maxInFlight),
            [], "[6c]")
        let callRun = runProbeJobs(count: 50) { callWorker.submit($0) }
        XCTAssertEqual(
            serialRunProblems(callRun.samples, count: 50, name: "gg.sloga.e2ee.call", maxInFlight: callRun.maxInFlight),
            [], "[6d]")
        if let engineThread = engineRun.samples.first?.thread, let callThread = callRun.samples.first?.thread {
            XCTAssertNotEqual(engineThread, callThread, "[6e] both workers run on one thread")
        } else {
            XCTFail("[6f] a probe job never ran")
        }

        let callRan = DispatchSemaphore(value: 0)
        let overlapped = Locked<Bool?>(nil)
        let done = expectation(description: "a call job while the engine worker is blocked")
        done.expectedFulfillmentCount = 2
        engineWorker.submit {
            let met = callRan.wait(timeout: .now() + 10) == .success
            overlapped.update { $0 = met }
            done.fulfill()
        }
        callWorker.submit {
            callRan.signal()
            done.fulfill()
        }
        wait(for: [done], timeout: 30)
        XCTAssertEqual(overlapped.snapshot, true, "[6g] a call-worker job waited behind a blocked engine worker")
    }
}
