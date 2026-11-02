// RecoverySheetTests.swift (G9, lane T8): the native recovery sheets (IE
// plan D5 "Recovery sheets") and the Stage 5 fixes M1 (navigation teardown,
// rollback of a minted code nobody saw) and m1 (no sheet over a consent
// alert), and the W4 audit fix M2 (a kept bundle goes only to the user
// whose flow minted it, and the page is told with an empty event).
//
// setUp swaps the app's bundle-waiting hook out (tearDown puts it back), so
// no test tells the app's real page about a bundle it kept.
//
// Each test runs a real E2eeEngine on a fresh temp directory (provisioned
// with enable() where the flow needs it) and hands it to the sheet through
// `RecoverySheet.engineForTesting`, so the app's real store is never opened.
// The flow runs on its own thread, exactly as the plugin runs it; the test
// drives the sheet on main through the file's test hooks.
//
// The recovery code is not exposed by any hook. The restore tests read it
// from the sheet's code label (the same text a user reads), and never put it
// in a failure message.
//
// Every check runs against a known-bad subject too: `t8Control = true` swaps
// each checked value for the one a broken build would produce, and every test
// must then fail.
import AcutestE2eeBindings
import Capacitor
import Foundation
import Security
import UIKit
import WebKit
import XCTest
@testable import SlogaE2ee

private let t8Control = false

/// The real subject normally, the known-bad one in the control run.
private func subject<T>(_ real: @autoclosure () throws -> T, bad: @autoclosure () throws -> T) rethrows -> T {
    try t8Control ? bad() : real()
}

/// Written as literals, not read from the module, so a changed payload is caught.
private let declinedJson = #"{"type":"declined"}"#
private let busyJson = #"{"type":"busy"}"#
private let mismatchText = "That code did not match. Check it and try again."
private let bundleWaitingEvent = "backupBundleWaiting"

/// A ULID-shaped account id. Restore checks it against the id bound into
/// the backup header, so create and restore must use the same one.
private let testUserId = "01J9Z8Y7X6W5V4T3S2R1Q0P9N8"

/// Another account: differs from testUserId in its last symbol only.
private let otherUserId = "01J9Z8Y7X6W5V4T3S2R1Q0P9N9"

/// Valid in shape (12 groups of 5 Crockford symbols), wrong in value.
private let wrongCode = Array(repeating: "00000", count: 12).joined(separator: "-")

private let crockford = Set("0123456789ABCDEFGHJKMNPQRSTVWXYZ")

/// The production wrap-key identity (e2ee-core ios_keychain.rs PRODUCTION).
/// A temp-dir engine wraps its master key with this item, creating it if
/// it is missing; a test removes it again only if it created it.
private enum WrapItem {
    static let service = "gg.sloga.app.e2ee"
    static let account = "e2ee-master-wrap"
    static let accessGroup = "M6UUDLK2XQ.gg.sloga.app.e2ee"
}

private struct T8Failure: Error {
    let reason: String
}

// MARK: - Shared helpers (nonisolated: some run on background threads)

/// Runs `body` on main with UIKit's isolation. Test methods run on main.
private func ui<T: Sendable>(_ body: @MainActor () -> T) -> T {
    dispatchPrecondition(condition: .onQueue(.main))
    return MainActor.assumeIsolated(body)
}

/// A value set once on a background thread and polled from main.
private final class Box<Value>: @unchecked Sendable {
    private let lock = NSLock()
    private var stored: Value?

    func set(_ value: Value) {
        lock.lock()
        stored = value
        lock.unlock()
    }

    var value: Value? {
        lock.lock()
        defer { lock.unlock() }
        return stored
    }
}

/// Never consents and never touches UIKit. Recovery never asks for consent,
/// so the tests also check that it was never called.
private final class NeverConfirm: NativeConfirm, @unchecked Sendable {
    private let lock = NSLock()
    private var count = 0

    func confirm(req: ConfirmPayload) throws -> Bool {
        lock.lock()
        count += 1
        lock.unlock()
        return false
    }

    var calls: Int {
        lock.lock()
        defer { lock.unlock() }
        return count
    }
}

/// What one CAPPluginCall settled with, in order (a second settle is a bug
/// the tests count, not trap).
private final class SettleRecorder: @unchecked Sendable {
    struct Settled {
        let keys: [String]
        let json: String?
        let reject: String?
    }

    private let lock = NSLock()
    private var settles: [Settled] = []

    func record(_ settled: Settled) {
        lock.lock()
        settles.append(settled)
        lock.unlock()
    }

    var all: [Settled] {
        lock.lock()
        defer { lock.unlock() }
        return settles
    }
}

/// What the bundle-waiting hook sent, in order: the event name, the
/// payload's keys, whether it ran on main, and what a refresh for the
/// sink's user took at that moment (never printed: it is a bundle).
private final class EventRecorder: @unchecked Sendable {
    struct Sent {
        let event: String
        let keys: [String]
        let onMain: Bool
        let taken: String?
    }

    private let lock = NSLock()
    private var sent: [Sent] = []

    func record(_ one: Sent) {
        lock.lock()
        sent.append(one)
        lock.unlock()
    }

    var all: [Sent] {
        lock.lock()
        defer { lock.unlock() }
        return sent
    }
}

/// The view controller a test presenter offers as its host. Set on main;
/// read by the presenter closure (on main) without touching UIKit.
private final class HostRef: @unchecked Sendable {
    weak var controller: UIViewController?
}

/// One temp-dir engine. The engine is dropped off main in tearDown, before
/// its directory is deleted.
private final class EngineHolder: @unchecked Sendable {
    let dir: URL
    let confirm = NeverConfirm()
    /// The publish body enable() returned (public keys only).
    let enableJson = Box<String>()
    private let lock = NSLock()
    private var engine: E2eeEngine?

    init(dir: URL) {
        self.dir = dir
    }

    func set(_ value: E2eeEngine?) {
        lock.lock()
        engine = value
        lock.unlock()
    }

    func get() throws -> E2eeEngine {
        lock.lock()
        defer { lock.unlock() }
        guard let engine else {
            throw T8Failure(reason: "engine released")
        }
        return engine
    }
}

/// Runs `body` on a new 8 MiB thread (the same kind engine calls use).
private func startOffMain<T>(_ name: String, _ body: @escaping () throws -> T) -> Box<Result<T, Error>> {
    let box = Box<Result<T, Error>>()
    runOnDedicatedThread(name: "gg.sloga.t8.\(name)") {
        box.set(Result { try body() })
    }
    return box
}

/// The fields core's BackupBundle serializes, and nothing else: an extra
/// field (a code, a key) fails the parse.
private struct BundleFields {
    let header: String
    let ciphertext: String
    let generation: Int
    let truncated: Bool

    init?(json: String) {
        guard let object = try? JSONSerialization.jsonObject(with: Data(json.utf8)) as? [String: Any],
              Set(object.keys) == ["header", "ciphertext", "generation", "truncated"],
              let header = object["header"] as? String, !header.isEmpty,
              let ciphertext = object["ciphertext"] as? String,
              let raw = Data(base64Encoded: ciphertext), !raw.isEmpty,
              let generation = object["generation"] as? Int,
              let truncated = object["truncated"] as? Bool
        else {
            return nil
        }
        self.header = header
        self.ciphertext = ciphertext
        self.generation = generation
        self.truncated = truncated
    }
}

/// Core's BackupStatus.
private struct StatusFields: Equatable {
    let exists: Bool
    let generation: Int
    let uploadedGeneration: Int
    let createdAt: Int
    let refreshedAt: Int

    init(exists: Bool, generation: Int, uploadedGeneration: Int, createdAt: Int, refreshedAt: Int) {
        self.exists = exists
        self.generation = generation
        self.uploadedGeneration = uploadedGeneration
        self.createdAt = createdAt
        self.refreshedAt = refreshedAt
    }

    init?(json: String) {
        guard let object = try? JSONSerialization.jsonObject(with: Data(json.utf8)) as? [String: Any],
              let exists = object["exists"] as? Bool,
              let generation = object["generation"] as? Int,
              let uploaded = object["uploaded_generation"] as? Int,
              let createdAt = object["created_at"] as? Int,
              let refreshedAt = object["refreshed_at"] as? Int
        else {
            return nil
        }
        self.exists = exists
        self.generation = generation
        self.uploadedGeneration = uploaded
        self.createdAt = createdAt
        self.refreshedAt = refreshedAt
    }

    /// What a build without the M1 rollback leaves after a create mint.
    static let liveBackup = StatusFields(exists: true, generation: 1, uploadedGeneration: 0, createdAt: 1, refreshedAt: 1)
    /// Core's "no local backup" (backup.rs backup_status).
    static let noBackup = StatusFields(exists: false, generation: 0, uploadedGeneration: 0, createdAt: 0, refreshedAt: 0)
}

/// The code read off the sheet, and how many lines the label used.
private struct ShownCode: Sendable {
    let code: String
    let lines: Int
}

/// The code as the sheet's label shows it (three lines of four groups),
/// turned back into the core's `XXXXX-…` form. nil unless it is exactly
/// 12 groups of 5 Crockford symbols.
private func recoveryCode(fromDisplay text: String) -> String? {
    let joined = text.replacingOccurrences(of: "\n", with: "-")
    let groups = joined.split(separator: "-", omittingEmptySubsequences: false)
    let wellFormed = groups.allSatisfy { group in
        group.count == 5 && group.allSatisfy { symbol in crockford.contains(symbol) }
    }
    guard groups.count == 12, wellFormed else {
        return nil
    }
    return joined
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

// MARK: - Tests

final class RecoverySheetTests: XCTestCase {
    private var root: UIViewController?
    private var holders: [EngineHolder] = []
    private var running: [() -> Bool] = []
    private var wrapItemExisted = true
    /// The app's bundle-waiting hook (its E2ee plugin's, installed at load),
    /// put back in tearDown.
    private var savedHook: (() -> Void)?
    private var hookSaved = false

    @MainActor private static func appRootViewController() -> UIViewController? {
        let windows = UIApplication.shared.connectedScenes
            .compactMap { $0 as? UIWindowScene }
            .flatMap { $0.windows }
        return (windows.first { $0.isKeyWindow } ?? windows.first)?.rootViewController
    }

    override func setUpWithError() throws {
        try super.setUpWithError()
        #if targetEnvironment(simulator)
        let status = wrapItemStatus()
        guard status == errSecSuccess || status == errSecItemNotFound else {
            throw T8Failure(reason: "could not look up the wrap item (OSStatus \(status))")
        }
        wrapItemExisted = status == errSecSuccess
        // A bundle another test left for "the next page" is not this test's.
        // A take clears it whoever asks.
        _ = RecoverySheet.takeOrphanedBundle(userId: testUserId)
        savedHook = RecoverySheet.bundleWaitingHook
        hookSaved = true
        RecoverySheet.bundleWaitingHook = nil
        #else
        // The engines here create the production wrap item when it is
        // missing; only the Simulator may have it removed again.
        throw XCTSkip("RecoverySheetTests use the production keychain identity; Simulator only")
        #endif

        var found: UIViewController?
        waitOnMain("the app has a root view controller in a window", timeout: 30) {
            found = ui { () -> UIViewController? in
                guard let vc = Self.appRootViewController(), vc.viewIfLoaded?.window != nil else {
                    return nil
                }
                return vc
            }
            return found != nil
        }
        root = found
        guard let root = found else {
            return
        }
        // Every main-frame load runs RecoverySheet.teardownForNavigation()
        // and declines any consent alert; start only once the page is
        // loaded, so the app's own load cannot close a sheet under test.
        waitOnMain("the web view finished loading", timeout: 30) {
            ui { (root as? CAPBridgeViewController)?.webView?.isLoading == false }
        }
        waitOnMain("the root view controller is not presenting anything") {
            ui { root.presentedViewController == nil }
        }
    }

    override func tearDownWithError() throws {
        // End every flow the test started: a sheet still up is closed (full
        // teardown), a consent alert declined. Repeated, because a flow may
        // not have claimed the sheet yet when the first call runs.
        var rounds = 0
        while running.contains(where: { !$0() }) && rounds < 60 {
            RecoverySheet.teardown()
            NativeConfirmPresenter.shared.declineAll()
            spinMain(0.5)
            rounds += 1
        }
        if running.contains(where: { !$0() }) {
            XCTFail("a flow started by the test did not end within 30 s of teardown")
        }
        running = []
        RecoverySheet.engineForTesting = nil
        _ = RecoverySheet.takeOrphanedBundle(userId: testUserId)
        if hookSaved {
            RecoverySheet.bundleWaitingHook = savedHook
            savedHook = nil
            hookSaved = false
        }

        if let root = root {
            let clean = waitOnMain("nothing is left presented after the test", timeout: 10) {
                ui { root.presentedViewController == nil }
            }
            if !clean {
                ui { () -> Void in root.presentedViewController?.dismiss(animated: false) }
            }
        }
        root = nil

        for holder in holders {
            _ = offMain("release the engine") { () -> Bool in
                holder.set(nil)
                return true
            }
            try? FileManager.default.removeItem(at: holder.dir)
        }
        holders = []

        #if targetEnvironment(simulator)
        if !wrapItemExisted {
            let status = SecItemDelete(wrapItemQuery() as CFDictionary)
            XCTAssertTrue(status == errSecSuccess || status == errSecItemNotFound,
                          "could not remove the wrap item this test created (OSStatus \(status))")
        }
        #endif
        try super.tearDownWithError()
    }

    // MARK: Main-thread helpers

    /// Polls `condition` on main, running the main run loop in between so
    /// queued main blocks (presentation, dismissal, sheet updates) run.
    @discardableResult
    private func waitOnMain(
        _ what: String,
        timeout: TimeInterval = 30,
        file: StaticString = #filePath,
        line: UInt = #line,
        _ condition: () -> Bool
    ) -> Bool {
        dispatchPrecondition(condition: .onQueue(.main))
        let deadline = Date(timeIntervalSinceNow: timeout)
        while !condition() {
            if Date() >= deadline {
                XCTFail("timed out after \(timeout) s waiting for: \(what)", file: file, line: line)
                return false
            }
            _ = RunLoop.current.run(mode: .default, before: Date(timeIntervalSinceNow: 0.01))
        }
        return true
    }

    /// Lets main run for `seconds`, so anything queued gets its chance.
    private func spinMain(_ seconds: TimeInterval) {
        dispatchPrecondition(condition: .onQueue(.main))
        let end = Date(timeIntervalSinceNow: seconds)
        while Date() < end {
            _ = RunLoop.current.run(mode: .default, before: end)
        }
    }

    /// Runs `body` off main and waits for it from main. nil on failure.
    private func offMain<T>(
        _ what: String,
        file: StaticString = #filePath,
        line: UInt = #line,
        _ body: @escaping () throws -> T
    ) -> T? {
        let box = startOffMain(what, body)
        guard waitOnMain(what, file: file, line: line, { box.value != nil }), let result = box.value else {
            return nil
        }
        switch result {
        case .success(let value):
            return value
        case .failure(let error):
            XCTFail("\(what) failed: \(rejectJson(for: error))", file: file, line: line)
            return nil
        }
    }

    // MARK: Engines and flows

    private func makeEngine(provision: Bool, file: StaticString = #filePath, line: UInt = #line) -> EngineHolder? {
        let dir = FileManager.default.temporaryDirectory
            .appendingPathComponent("T8-\(UUID().uuidString)", isDirectory: true)
        do {
            try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        } catch {
            XCTFail("could not create a temp store dir", file: file, line: line)
            return nil
        }
        let holder = EngineHolder(dir: dir)
        holders.append(holder)
        let provisioned = offMain("engine setup", file: file, line: line) { () -> Bool in
            dispatchPrecondition(condition: .notOnQueue(.main))
            let engine = try E2eeEngine(storeDir: dir.path, confirm: holder.confirm)
            holder.set(engine)
            if provision {
                holder.enableJson.set(try engine.enable())
            }
            return try engine.isProvisioned()
        }
        guard provisioned == provision else {
            XCTFail("the temp store is not in the expected state (provisioned \(String(describing: provisioned)))",
                    file: file, line: line)
            return nil
        }
        return holder
    }

    /// The device id the engine published on enable (the restore test
    /// compares the restored device against it).
    private func enableDeviceId(_ holder: EngineHolder) -> String? {
        guard let json = holder.enableJson.value,
              let object = try? JSONSerialization.jsonObject(with: Data(json.utf8)) as? [String: Any],
              let deviceId = object["device_id"] as? String, !deviceId.isEmpty
        else {
            XCTFail("enable() returned no device_id")
            return nil
        }
        return deviceId
    }

    private func status(_ holder: EngineHolder, file: StaticString = #filePath, line: UInt = #line) -> StatusFields? {
        let json = offMain("backupStatus", file: file, line: line) { () -> String in
            dispatchPrecondition(condition: .notOnQueue(.main))
            return try holder.get().backupStatus()
        }
        guard let json else {
            return nil
        }
        guard let fields = StatusFields(json: json) else {
            XCTFail("backupStatus is not a BackupStatus object", file: file, line: line)
            return nil
        }
        return fields
    }

    /// What a take would courier now (and promote, if core held a mint).
    private func takePending(_ holder: EngineHolder, file: StaticString = #filePath, line: UInt = #line) -> String? {
        offMain("backupTakePendingUpload", file: file, line: line) { () -> String in
            dispatchPrecondition(condition: .notOnQueue(.main))
            return try holder.get().backupTakePendingUpload()
        }
    }

    private func isProvisioned(_ holder: EngineHolder) -> Bool? {
        offMain("isProvisioned") { () -> Bool in
            dispatchPrecondition(condition: .notOnQueue(.main))
            return try holder.get().isProvisioned()
        }
    }

    private func use(_ holder: EngineHolder) {
        RecoverySheet.engineForTesting = { try holder.get() }
    }

    private func startCreate(rotate: Bool = false) -> Box<Result<String, Error>> {
        let box = startOffMain(rotate ? "rotate" : "create") { () -> String in
            try RecoverySheet.runCreateOrRotate(rotate: rotate, userId: testUserId)
        }
        running.append { box.value != nil }
        return box
    }

    private func startRestore(blobsJson: String) -> Box<Result<String, Error>> {
        let box = startOffMain("restore") { () -> String in
            try RecoverySheet.runRestore(userId: testUserId, blobsJson: blobsJson)
        }
        running.append { box.value != nil }
        return box
    }

    private func result(
        of flow: Box<Result<String, Error>>,
        file: StaticString = #filePath,
        line: UInt = #line
    ) -> Result<String, Error>? {
        guard waitOnMain("the recovery flow returned", file: file, line: line, { flow.value != nil }) else {
            return nil
        }
        return flow.value
    }

    // MARK: Sheet helpers

    private var stage: String? {
        ui { RecoverySheet.stageForTesting }
    }

    private func tap(_ button: String) {
        ui { RecoverySheet.tapForTesting(button) }
    }

    /// The sheet is fully presented (not mid-animation) on the root and shows `name`.
    @discardableResult
    private func waitForStage(_ name: String, file: StaticString = #filePath, line: UInt = #line) -> Bool {
        waitOnMain("the sheet shows stage \"\(name)\"", file: file, line: line) {
            ui { () -> Bool in
                guard RecoverySheet.stageForTesting == name,
                      let sheet = self.root?.presentedViewController,
                      !(sheet is UIAlertController)
                else {
                    return false
                }
                return !sheet.isBeingPresented && sheet.viewIfLoaded?.window != nil
            }
        }
    }

    /// True while a recovery sheet (anything but an alert) is presented on the root.
    private var sheetOnScreen: Bool {
        ui { () -> Bool in
            guard let presented = self.root?.presentedViewController else {
                return false
            }
            return !(presented is UIAlertController) && !presented.isBeingDismissed
        }
    }

    @MainActor private static func labels(in root: UIViewController?) -> [UILabel] {
        guard let view = root?.presentedViewController?.viewIfLoaded else {
            return []
        }
        var found: [UILabel] = []
        var pending: [UIView] = [view]
        while let next = pending.popLast() {
            if let label = next as? UILabel {
                found.append(label)
            }
            pending.append(contentsOf: next.subviews)
        }
        return found
    }

    /// The code the sheet displays, read from its label.
    private func displayedCode() -> ShownCode? {
        ui { () -> ShownCode? in
            for label in Self.labels(in: self.root) where !label.isHidden {
                if let text = label.text, let code = recoveryCode(fromDisplay: text) {
                    return ShownCode(code: code, lines: text.split(separator: "\n").count)
                }
            }
            return nil
        }
    }

    private func visibleTexts() -> [String] {
        ui { Self.labels(in: self.root).filter { !$0.isHidden }.compactMap { $0.text } }
    }

    // MARK: Checkers

    private func assertRejected(
        _ result: Result<String, Error>?,
        _ json: String,
        _ what: String,
        file: StaticString = #filePath,
        line: UInt = #line
    ) {
        guard let result else {
            XCTFail("\(what): the flow did not end", file: file, line: line)
            return
        }
        switch result {
        case .success:
            XCTFail("\(what): resolved a value; expected the reject \(json)", file: file, line: line)
        case .failure(let error):
            XCTAssertEqual(rejectJson(for: error), json, what, file: file, line: line)
        }
    }

    @discardableResult
    private func assertBundle(
        _ result: Result<String, Error>?,
        _ what: String,
        file: StaticString = #filePath,
        line: UInt = #line
    ) -> (fields: BundleFields, json: String)? {
        guard let result else {
            XCTFail("\(what): the flow did not end", file: file, line: line)
            return nil
        }
        switch result {
        case .failure(let error):
            XCTFail("\(what): rejected with \(rejectJson(for: error)); expected the bundle", file: file, line: line)
            return nil
        case .success(let json):
            guard let fields = BundleFields(json: json) else {
                let shape = json == "null" ? "the string null" : "\(json.utf8.count) bytes that are not a bundle"
                XCTFail("\(what): resolved \(shape); expected a BackupBundle", file: file, line: line)
                return nil
            }
            return (fields, json)
        }
    }

    /// Create flow up to the code being on screen.
    private func runToCode(rotate: Bool = false, file: StaticString = #filePath, line: UInt = #line)
        -> Box<Result<String, Error>>?
    {
        let flow = startCreate(rotate: rotate)
        guard waitForStage("intro", file: file, line: line) else {
            return nil
        }
        tap("create")
        guard waitForStage("code", file: file, line: line) else {
            return nil
        }
        return flow
    }

    /// A create flow finished with "I saved it": the bundle JSON and the code shown.
    private func createBackup(on holder: EngineHolder, file: StaticString = #filePath, line: UInt = #line)
        -> (fields: BundleFields, json: String, code: String)?
    {
        use(holder)
        guard let flow = runToCode(file: file, line: line) else {
            return nil
        }
        guard let shown = displayedCode() else {
            XCTFail("the code stage shows no 12x5 recovery code", file: file, line: line)
            return nil
        }
        tap("saved")
        guard let bundle = assertBundle(result(of: flow, file: file, line: line), "create", file: file, line: line)
        else {
            return nil
        }
        return (bundle.fields, bundle.json, shown.code)
    }

    // MARK: 1. Create happy path

    func testCreateShowsCodeThenSavedReturnsBundleAndStatusRecordsIt() {
        guard let holder = makeEngine(provision: true), let before = status(holder) else {
            return
        }
        XCTAssertEqual(before, StatusFields.noBackup, "a fresh store has no backup")
        use(holder)
        guard let flow = runToCode() else {
            return
        }
        let shown = displayedCode()
        XCTAssertNotNil(shown, "the code stage shows a 12x5 recovery code")
        XCTAssertEqual(shown?.lines, 3, "the code is shown as three lines of four groups")
        XCTAssertNil(flow.value, "the flow waits for the user while the code is shown")

        tap("saved")
        let checked = subject(result(of: flow), bad: Result<String, Error>.success("null"))
        let bundle = assertBundle(checked, "create, I saved it")
        XCTAssertEqual(bundle?.fields.generation, 1, "first backup of a store is generation 1")
        if let bundle, let shown {
            let bare = shown.code.replacingOccurrences(of: "-", with: "")
            XCTAssertFalse(bundle.json.contains(shown.code) || bundle.json.contains(bare),
                           "the bundle the webview gets does not contain the code")
        }
        waitOnMain("the sheet is gone") { stage == nil && !sheetOnScreen }

        let after = subject(status(holder), bad: before)
        XCTAssertEqual(after?.exists, true, "the courier's take made the minted key the active backup")
        XCTAssertEqual(after?.generation, bundle?.fields.generation, "status generation = the bundle's")
        XCTAssertEqual(after?.uploadedGeneration, 0, "nothing is uploaded until the courier confirms")
        XCTAssertGreaterThan(after?.createdAt ?? 0, 0, "created_at is set")
        XCTAssertEqual(holder.confirm.calls, 0, "recovery never asks for a native consent")
    }

    // MARK: 2. F3: a displayed code is couriered on any close

    func testCloseAfterCodeShownStillReturnsTheBundle() {
        guard let holder = makeEngine(provision: true) else {
            return
        }
        use(holder)
        guard let flow = runToCode() else {
            return
        }
        // No Cancel or Close once the code is up: the backup is uploaded on
        // any close from here, so those buttons are not offered.
        tap("cancel")
        tap("close")
        spinMain(0.5)
        XCTAssertEqual(stage, "code", "cancel/close are not available while the code is shown")
        XCTAssertNil(flow.value, "the flow is still waiting")

        RecoverySheet.teardown()
        let checked = subject(result(of: flow), bad: Result<String, Error>.failure(E2eeReject.declined))
        assertBundle(checked, "full teardown after the code was shown (F3)")
        waitOnMain("the sheet is gone") { stage == nil && !sheetOnScreen }
        XCTAssertEqual(status(holder)?.exists, true, "the backup state stays: the user holds its code")
    }

    // MARK: 3. M1: navigation teardown

    func testNavigationTeardownInIntroDeclinesAndLeavesNoBackup() {
        guard let holder = makeEngine(provision: true) else {
            return
        }
        use(holder)
        let flow = startCreate()
        guard waitForStage("intro") else {
            return
        }
        RecoverySheet.teardownForNavigation()
        let checked = subject(result(of: flow), bad: Result<String, Error>.success("{}"))
        assertRejected(checked, declinedJson, "navigation before Create")
        waitOnMain("the sheet is gone") { stage == nil && !sheetOnScreen }
        XCTAssertEqual(status(holder), StatusFields.noBackup, "nothing was minted")
    }

    func testNavigationTeardownWhileCodeShownKeepsTheSheetAndStillReturnsTheBundle() {
        guard let holder = makeEngine(provision: true) else {
            return
        }
        use(holder)
        guard let flow = runToCode() else {
            return
        }
        RecoverySheet.teardownForNavigation()
        spinMain(0.5)
        XCTAssertEqual(subject(stage, bad: nil), "code", "the code stays on screen across a page load")
        XCTAssertTrue(sheetOnScreen, "the sheet is still presented")
        XCTAssertNil(flow.value, "the flow is still waiting for the user")

        tap("saved")
        assertBundle(result(of: flow), "I saved it after a page load")
        XCTAssertEqual(status(holder)?.exists, true, "the backup state is live")
    }

    func testNavigationTeardownDuringMintKeepsTheSheetAndStillReturnsTheBundle() {
        guard let holder = makeEngine(provision: true) else {
            return
        }
        use(holder)
        let flow = startCreate()
        guard waitForStage("intro") else {
            return
        }
        // The tap moves the stage to minting at once, on main, before the
        // Argon2 run starts on the flow thread; the navigation teardown is
        // handled on main after it, so it always meets "minting" (or
        // "code", should the mint already be done).
        tap("create")
        XCTAssertEqual(stage, "minting", "Create starts the mint")
        RecoverySheet.teardownForNavigation()
        let survived = waitForStage("code")
        XCTAssertTrue(subject(survived && sheetOnScreen, bad: false),
                      "the sheet survives a page load during the mint and shows the code")
        XCTAssertNil(flow.value, "the flow is still waiting for the user")

        tap("saved")
        assertBundle(result(of: flow), "I saved it after a page load during the mint")
        XCTAssertEqual(status(holder)?.exists, true, "the backup state is live")
    }

    func testNavigationTeardownInRestoreEntryDeclines() {
        guard let holder = makeEngine(provision: false) else {
            return
        }
        use(holder)
        let flow = startRestore(blobsJson: "[]")
        guard waitForStage("entry") else {
            return
        }
        RecoverySheet.teardownForNavigation()
        let checked = subject(result(of: flow), bad: Result<String, Error>.success("null"))
        assertRejected(checked, declinedJson, "navigation before Restore")
        waitOnMain("the sheet is gone") { stage == nil && !sheetOnScreen }
        XCTAssertEqual(isProvisioned(holder), false, "nothing was restored")
    }

    func testFullTeardownInIntroDeclines() {
        guard let holder = makeEngine(provision: true) else {
            return
        }
        use(holder)
        let flow = startCreate()
        guard waitForStage("intro") else {
            return
        }
        RecoverySheet.teardown()
        let checked = subject(result(of: flow), bad: Result<String, Error>.success("{}"))
        assertRejected(checked, declinedJson, "full teardown before Create")
        waitOnMain("the sheet is gone") { stage == nil && !sheetOnScreen }
        XCTAssertEqual(status(holder), StatusFields.noBackup, "nothing was minted")
    }

    // MARK: 4. M1(b): minted but never shown is rolled back

    func testFullTeardownDuringCreateMintDeclinesAndDiscardsTheMintedState() {
        guard let holder = makeEngine(provision: true) else {
            return
        }
        use(holder)
        let flow = startCreate()
        guard waitForStage("intro") else {
            return
        }
        tap("create")
        // The .mint event is queued before the close, so the flow thread
        // mints first and handles the close only after Argon2 returns.
        XCTAssertEqual(stage, "minting", "Create starts the mint")
        RecoverySheet.teardown()
        assertRejected(result(of: flow), declinedJson, "full teardown during the mint")
        waitOnMain("the sheet is gone") { stage == nil && !sheetOnScreen }
        let after = subject(status(holder), bad: StatusFields.liveBackup)
        XCTAssertEqual(after, StatusFields.noBackup, "no local backup key is left that nobody holds a code for")
        // The mint writes nothing, so the status check alone also passes with
        // no rollback at all. A take now would promote a mint still held in
        // core's slot: it must find nothing, and leave the status unchanged.
        XCTAssertEqual(takePending(holder), "null", "the never-shown mint was discarded, not left to a take")
        XCTAssertEqual(status(holder), StatusFields.noBackup, "a later take activates nothing")
    }

    /// The same rollback on rotate: before the rotate the store holds
    /// generation 1 under a code the user saved. The discard keeps exactly
    /// that key active; the take afterwards proves the never-shown mint is
    /// gone (a mint left in the slot would promote to generation 2 there).
    func testFullTeardownDuringRotateMintDiscardsTheMintedState() {
        guard let holder = makeEngine(provision: true), createBackup(on: holder) != nil,
              let before = status(holder)
        else {
            return
        }
        XCTAssertTrue(before.exists && before.generation == 1, "setup: one backup at generation 1")
        let flow = startCreate(rotate: true)
        guard waitForStage("intro") else {
            return
        }
        tap("create")
        XCTAssertEqual(stage, "minting", "Create code starts the rotate mint")
        RecoverySheet.teardown()
        assertRejected(result(of: flow), declinedJson, "full teardown during the rotate mint")
        let after = subject(status(holder), bad: StatusFields.noBackup)
        XCTAssertEqual(after, before, "the saved code's key stays active; the never-shown key never became active")
        XCTAssertEqual(takePending(holder), "null", "the never-shown mint was discarded, not left to a take")
        XCTAssertEqual(status(holder), before, "a later take activates nothing")
    }

    // MARK: 5. m1: never over a consent alert

    func testRefusesBusyWhileANativeConsentAlertIsUp() {
        guard let holder = makeEngine(provision: true) else {
            return
        }
        use(holder)
        let payload = ConfirmPayload(
            title: "T8 busy check",
            message: "Held open by RecoverySheetTests.",
            confirmLabel: "OK",
            cancelLabel: "Cancel",
            kind: "info",
            defaultButton: "cancel"
        )
        let answer = startOffMain("consent") { () -> Bool in
            dispatchPrecondition(condition: .notOnQueue(.main))
            return try NativeConfirmPresenter.shared.confirm(req: payload)
        }
        running.append { answer.value != nil }
        guard waitOnMain("the consent alert is on screen", { ui { NativeConfirmPresenter.shared.presentedAlertForTesting != nil } })
        else {
            return
        }
        XCTAssertTrue(NativeConfirmPresenter.shared.isBusy, "the consent slot is held")

        let flow = startCreate()
        let checked = subject(result(of: flow), bad: Result<String, Error>.failure(E2eeReject.declined))
        assertRejected(checked, busyJson, "create while a consent alert is up")
        spinMain(0.3)
        XCTAssertNil(stage, "no sheet was created")
        let alertStillTop = ui { () -> Bool in
            guard let alert = NativeConfirmPresenter.shared.presentedAlertForTesting else {
                return false
            }
            return self.root?.presentedViewController === alert && alert.presentedViewController == nil
        }
        XCTAssertTrue(alertStillTop, "the alert is still the top view controller, nothing stacked on it")

        NativeConfirmPresenter.shared.declineAll()
        waitOnMain("the consent call returned") { answer.value != nil }
        if case .success(let value)? = answer.value {
            XCTAssertFalse(value, "the declined alert answers false")
        } else {
            XCTFail("the consent call threw")
        }
        waitOnMain("the alert is gone") { ui { self.root?.presentedViewController == nil } }
        XCTAssertEqual(status(holder), StatusFields.noBackup, "the refused flow minted nothing")

        // Positive control: with the alert gone the same call shows the
        // sheet, so the refusal above came from the alert.
        let again = startCreate()
        XCTAssertTrue(waitForStage("intro"), "the sheet appears once no alert is up")
        tap("cancel")
        assertRejected(result(of: again), declinedJson, "cancel in intro")
    }

    func testRefusesBusyWhileAnyAlertIsTheTopViewController() {
        guard let holder = makeEngine(provision: true), let root = root else {
            return
        }
        use(holder)
        ui { () -> Void in
            let alert = UIAlertController(title: "T8", message: "Plain alert", preferredStyle: .alert)
            alert.addAction(UIAlertAction(title: "OK", style: .cancel))
            root.present(alert, animated: false)
        }
        guard waitOnMain("the plain alert is on screen", {
            ui { () -> Bool in
                guard let alert = root.presentedViewController as? UIAlertController else {
                    return false
                }
                return !alert.isBeingPresented
            }
        }) else {
            return
        }
        XCTAssertFalse(NativeConfirmPresenter.shared.isBusy, "this alert is not a consent request")

        let flow = startCreate()
        let checked = subject(result(of: flow), bad: Result<String, Error>.failure(E2eeReject.declined))
        assertRejected(checked, busyJson, "create while another alert is the top view controller")
        spinMain(0.3)
        XCTAssertNil(stage, "no sheet was created")
        XCTAssertTrue(ui { root.presentedViewController is UIAlertController && root.presentedViewController?.presentedViewController == nil },
                      "nothing was stacked on the alert")
        ui { () -> Void in root.dismiss(animated: false) }
        waitOnMain("the alert is gone") { ui { root.presentedViewController == nil } }
    }

    /// A second flow while a sheet is open is refused before it reaches
    /// core: recovery_open would otherwise overwrite the open flow's context
    /// (a create sheet silently turned into a restore).
    func testSecondFlowWhileASheetIsOpenIsBusyAndLeavesTheFirstAlone() {
        guard let holder = makeEngine(provision: true) else {
            return
        }
        use(holder)
        let first = startCreate()
        guard waitForStage("intro") else {
            return
        }
        let second = startRestore(blobsJson: "[]")
        let checked = subject(result(of: second), bad: Result<String, Error>.failure(E2eeReject.declined))
        assertRejected(checked, busyJson, "a second flow while a sheet is open")
        spinMain(0.3)
        XCTAssertEqual(stage, "intro", "the open sheet is unchanged")
        XCTAssertNil(first.value, "the first flow is still waiting")

        // The first sheet is still a create sheet, end to end.
        tap("create")
        XCTAssertTrue(waitForStage("code"), "the first sheet still mints")
        tap("saved")
        assertBundle(result(of: first), "the first flow after the refused second one")
    }

    // MARK: 6. Restore

    func testRestoreWrongCodeKeepsTheSheetThenRightCodeRestores() {
        guard let source = makeEngine(provision: true), let deviceId = enableDeviceId(source),
              let backup = createBackup(on: source)
        else {
            return
        }
        guard let target = makeEngine(provision: false) else {
            return
        }
        let blob: [[String: Any]] = [[
            "header": backup.fields.header,
            "ciphertext": backup.fields.ciphertext,
            "server_generation": backup.fields.generation,
        ]]
        guard let blobData = try? JSONSerialization.data(withJSONObject: blob),
              let blobsJson = String(data: blobData, encoding: .utf8)
        else {
            XCTFail("could not build the blobs JSON")
            return
        }
        use(target)
        let flow = startRestore(blobsJson: blobsJson)
        guard waitForStage("entry") else {
            return
        }

        // Wrong code; a page load while it is checked must not close the sheet.
        ui { RecoverySheet.enterCodeForTesting(wrongCode) }
        tap("restore")
        XCTAssertEqual(stage, "restoring", "Restore starts the check")
        RecoverySheet.teardownForNavigation()
        guard waitOnMain("the mismatch is reported", { stage == "entry" && visibleTexts().contains(mismatchText) })
        else {
            return
        }
        XCTAssertTrue(subject(sheetOnScreen, bad: false), "a wrong code keeps the sheet open")
        XCTAssertNil(flow.value, "the flow is still waiting for the user")
        XCTAssertEqual(isProvisioned(target), false, "a wrong code restores nothing")

        // Right code; again a page load during the restore.
        ui { RecoverySheet.enterCodeForTesting(backup.code) }
        tap("restore")
        XCTAssertEqual(stage, "restoring", "Restore starts the check")
        RecoverySheet.teardownForNavigation()
        let checked = subject(result(of: flow), bad: Result<String, Error>.success("null"))
        guard case .success(let republish)? = checked else {
            if case .failure(let error)? = checked {
                XCTFail("restore rejected with \(rejectJson(for: error))")
            } else {
                XCTFail("restore did not end")
            }
            return
        }
        let object = try? JSONSerialization.jsonObject(with: Data(republish.utf8)) as? [String: Any]
        XCTAssertNotNil(object, "restore resolves the republish payload object, not null")
        XCTAssertEqual(object?["device_id"] as? String, deviceId, "the restored device is the backed-up one")
        let bare = backup.code.replacingOccurrences(of: "-", with: "")
        XCTAssertFalse(republish.contains(backup.code) || republish.contains(bare),
                       "the republish payload does not contain the code")
        waitOnMain("the sheet is gone") { stage == nil && !sheetOnScreen }

        XCTAssertEqual(isProvisioned(target), true, "the target store was rebuilt")
        let restored = status(target)
        XCTAssertEqual(restored?.exists, true, "restore re-establishes the backup state")
        XCTAssertEqual(restored?.generation, backup.fields.generation, "at the restored generation")
        XCTAssertEqual(restored?.uploadedGeneration, backup.fields.generation, "which the server already holds")
    }

    func testRestoreWrongCodeThenCancelDeclines() {
        guard let source = makeEngine(provision: true), let backup = createBackup(on: source),
              let target = makeEngine(provision: false)
        else {
            return
        }
        let blob: [[String: Any]] = [["header": backup.fields.header, "ciphertext": backup.fields.ciphertext]]
        guard let blobData = try? JSONSerialization.data(withJSONObject: blob),
              let blobsJson = String(data: blobData, encoding: .utf8)
        else {
            XCTFail("could not build the blobs JSON")
            return
        }
        use(target)
        let flow = startRestore(blobsJson: blobsJson)
        guard waitForStage("entry") else {
            return
        }
        ui { RecoverySheet.enterCodeForTesting(wrongCode) }
        tap("restore")
        let reported = waitOnMain("the mismatch is reported") {
            stage == "entry" && visibleTexts().contains(mismatchText)
        }
        XCTAssertTrue(subject(reported && sheetOnScreen, bad: false), "a wrong code keeps the sheet open")

        tap("cancel")
        let checked = subject(result(of: flow), bad: Result<String, Error>.success("null"))
        assertRejected(checked, declinedJson, "cancel after a wrong code")
        waitOnMain("the sheet is gone") { stage == nil && !sheetOnScreen }
        XCTAssertEqual(isProvisioned(target), false, "nothing was restored")
    }

    // MARK: 7. Orphaned bundle: a sheet that outlived its page

    /// Create, a page load while the code is shown (the sheet stays), then
    /// "I saved it". The resolved bundle JSON, or nil (and a failure).
    private func runSurvivingNavigation(file: StaticString = #filePath, line: UInt = #line) -> String? {
        guard let flow = runToCode(file: file, line: line) else {
            return nil
        }
        RecoverySheet.teardownForNavigation()
        spinMain(0.3)
        guard stage == "code" else {
            XCTFail("the sheet did not survive the page load", file: file, line: line)
            return nil
        }
        tap("saved")
        return assertBundle(result(of: flow, file: file, line: line), "I saved it after a page load",
                            file: file, line: line)?.json
    }

    // Bundle comparisons below use XCTAssertTrue: XCTAssertEqual/Nil would
    // print the whole bundle into the test log on a failure.

    func testSheetThatOutlivedItsPageLeavesItsBundleForTheNextPageOnce() {
        guard let holder = makeEngine(provision: true) else {
            return
        }
        use(holder)
        guard let bundle = runSurvivingNavigation() else {
            return
        }
        let first = subject(RecoverySheet.takeOrphanedBundle(userId: testUserId), bad: nil)
        XCTAssertTrue(first == bundle, "the bundle the old call resolved is kept for the minting user's next page")
        let second = subject(RecoverySheet.takeOrphanedBundle(userId: testUserId), bad: bundle)
        XCTAssertTrue(second == nil, "it is handed out once")
    }

    /// The other close a code-stage sheet can get: dismissed from outside
    /// (its presenter torn down). After a page load during the mint, the
    /// bundle couriered on that close (F3) is kept as well.
    func testDismissedFromOutsideAfterAPageLoadDuringTheMintLeavesTheOrphan() {
        guard let holder = makeEngine(provision: true), let root = root else {
            return
        }
        use(holder)
        let flow = startCreate()
        guard waitForStage("intro") else {
            return
        }
        tap("create")
        XCTAssertEqual(stage, "minting", "Create starts the mint")
        RecoverySheet.teardownForNavigation()
        guard waitForStage("code") else {
            return
        }
        ui { () -> Void in root.dismiss(animated: false) }
        guard let bundle = assertBundle(result(of: flow), "dismissed from outside after the code was shown") else {
            return
        }
        let orphan = subject(RecoverySheet.takeOrphanedBundle(userId: testUserId), bad: nil)
        XCTAssertTrue(orphan == bundle.json, "the bundle is kept for the next page")
        XCTAssertTrue(RecoverySheet.takeOrphanedBundle(userId: testUserId) == nil, "and handed out once")
    }

    func testFlowWithoutAPageLoadLeavesNoOrphan() {
        guard let holder = makeEngine(provision: true), createBackup(on: holder) != nil else {
            return
        }
        let orphan = subject(RecoverySheet.takeOrphanedBundle(userId: testUserId), bad: "{}")
        XCTAssertTrue(orphan == nil, "the page that asked got the bundle; nothing is kept")
    }

    func testFullTeardownClearsTheOrphanAndKeepsNone() {
        guard let holder = makeEngine(provision: true) else {
            return
        }
        use(holder)
        // A kept bundle is dropped by the wipe's teardown, with no sheet open.
        guard runSurvivingNavigation() != nil else {
            return
        }
        RecoverySheet.teardown()
        XCTAssertTrue(subject(RecoverySheet.takeOrphanedBundle(userId: testUserId), bad: "{}") == nil,
                      "teardown() dropped the kept bundle")

        // A sheet that survived a page load and is then torn down by a wipe:
        // the call still resolves (F3), but nothing is kept for later.
        guard let flow = runToCode() else {
            return
        }
        RecoverySheet.teardownForNavigation()
        spinMain(0.3)
        XCTAssertEqual(stage, "code", "the sheet survived the page load")
        RecoverySheet.teardown()
        assertBundle(result(of: flow), "full teardown after a page load")
        XCTAssertTrue(subject(RecoverySheet.takeOrphanedBundle(userId: testUserId), bad: "{}") == nil,
                     "a bundle couriered after a wipe's teardown is never kept")
    }

    func testANewMintSupersedesAKeptOrphan() {
        guard let holder = makeEngine(provision: true) else {
            return
        }
        use(holder)
        guard let old = runSurvivingNavigation() else {
            return
        }
        guard let flow = runToCode() else {
            return
        }
        XCTAssertTrue(subject(RecoverySheet.takeOrphanedBundle(userId: testUserId), bad: old) == nil,
                     "the new mint dropped the older kept bundle")
        RecoverySheet.teardownForNavigation()
        spinMain(0.3)
        tap("saved")
        guard let new = assertBundle(result(of: flow), "the second sheet after a page load") else {
            return
        }
        XCTAssertTrue(new.json != old, "a new mint is a new bundle")
        let kept: String? = subject(RecoverySheet.takeOrphanedBundle(userId: testUserId), bad: old)
        XCTAssertTrue(kept == new.json,
                       "the kept bundle is the newest one")
    }

    /// The new page's refresh picks the kept bundle up through the real
    /// generic plugin path. Hermetic enough: the generic route builds the
    /// process engine (creating the app's store directory, never opening
    /// the store), and this arm returns the kept bundle before any engine
    /// method runs. Only one call is made: a call with nothing kept would
    /// run a refresh on the app's real store.
    func testRefreshIfDueThroughThePluginHandsOverTheOrphanOnce() {
        guard let holder = makeEngine(provision: true) else {
            return
        }
        use(holder)
        guard let bundle = runSurvivingNavigation() else {
            return
        }
        let realBefore = offMain("is the app's real store provisioned") { () -> Bool in
            dispatchPrecondition(condition: .notOnQueue(.main))
            return try E2eeRuntime.shared.engine().isProvisioned()
        }

        let recorder = SettleRecorder()
        let options: [String: Any] = ["__cmd": "e2ee_backup_refresh_if_due", "userId": testUserId]
        let jsOptions = JSTypes.coerceDictionaryToJSObject(options as NSDictionary, formattingDatesAsStrings: true) ?? [:]
        let made: CAPPluginCall? = CAPPluginCall(
            callbackId: "t8-\(UUID().uuidString)",
            methodName: "call",
            options: jsOptions,
            success: { result, _ in
                let data = result?.data ?? [:]
                recorder.record(.init(keys: data.keys.sorted(), json: data["json"] as? String, reject: nil))
            },
            error: { error in
                recorder.record(.init(keys: [], json: nil, reject: error?.message ?? "<nil error>"))
            }
        )
        guard let pluginCall = made else {
            XCTFail("CAPPluginCall init returned nil")
            return
        }
        let plugin = E2eePlugin()
        // Off main, as Capacitor's bridge queue would call it.
        runOnDedicatedThread(name: "gg.sloga.t8.bridge") {
            plugin.call(pluginCall)
        }
        guard waitOnMain("the plugin call settled", { !recorder.all.isEmpty }) else {
            return
        }
        spinMain(0.2)
        let settles = recorder.all
        XCTAssertEqual(settles.count, 1, "the call settles exactly once")
        XCTAssertNil(settles.first?.reject, "the call resolved")
        XCTAssertEqual(settles.first?.keys, ["json"], "resolved as {json}")
        let resolvedJson: String? = settles.first?.json
        let checkedJson: String? = subject(resolvedJson, bad: "null")
        XCTAssertTrue(checkedJson == bundle, "the refresh returns the kept bundle")
        XCTAssertTrue(subject(RecoverySheet.takeOrphanedBundle(userId: testUserId), bad: bundle) == nil, "handed over once")

        let realAfter = offMain("is the app's real store provisioned") { () -> Bool in
            dispatchPrecondition(condition: .notOnQueue(.main))
            return try E2eeRuntime.shared.engine().isProvisioned()
        }
        XCTAssertEqual(realAfter, realBefore, "the arm never opened the app's real store")
    }

    // MARK: 7b. M2: the kept bundle is the minting user's, and the page is told

    /// Puts the plugin's real emitter, with a recording sink, where the app's
    /// plugin hook was. The sink runs where the plugin's notifyListeners
    /// would and, given a user, takes the kept bundle for that user right
    /// then, as the page's refresh would.
    private func recordBundleWaiting(takeFor userId: String? = nil) -> EventRecorder {
        let recorder = EventRecorder()
        RecoverySheet.bundleWaitingHook = E2eePlugin.backupBundleWaitingEmitter { event, data in
            let taken = userId.flatMap { RecoverySheet.takeOrphanedBundle(userId: $0) }
            recorder.record(.init(event: event, keys: data.keys.sorted(), onMain: Thread.isMainThread, taken: taken))
        }
        return recorder
    }

    /// The same-user take is testSheetThatOutlivedItsPageLeavesItsBundleForTheNextPageOnce.
    /// Stage 6 (lane 3 MAJOR-1): a refresh for another account, e.g. from a
    /// stale page bridge after a logout, must not destroy the minting
    /// user's bundle on its way to nothing.
    func testARefreshForAnotherUserGetsNothingAndLeavesTheKeptBundle() {
        guard let holder = makeEngine(provision: true) else {
            return
        }
        use(holder)
        guard let bundle = runSurvivingNavigation() else {
            return
        }
        let foreign = subject(RecoverySheet.takeOrphanedBundle(userId: otherUserId), bad: bundle)
        XCTAssertTrue(foreign == nil, "a refresh for another account never gets the bundle")
        let later = subject(RecoverySheet.takeOrphanedBundle(userId: testUserId), bad: nil)
        XCTAssertEqual(later, bundle, "the minting user's later take still gets it")
        XCTAssertTrue(RecoverySheet.takeOrphanedBundle(userId: testUserId) == nil, "and only once")
    }

    func testAKeptBundleIsAnnouncedOnceWithAnEmptyEventAfterItIsKept() {
        guard let holder = makeEngine(provision: true) else {
            return
        }
        use(holder)
        let recorder = recordBundleWaiting(takeFor: testUserId)
        guard let bundle = runSurvivingNavigation() else {
            return
        }
        guard waitOnMain("the page was told", timeout: 10, { !recorder.all.isEmpty }) else {
            return
        }
        spinMain(0.5)
        let heard = recorder.all
        XCTAssertEqual(subject(heard.count, bad: 2), 1, "told exactly once for one kept bundle")
        XCTAssertEqual(heard.first?.event, bundleWaitingEvent, "as backupBundleWaiting")
        XCTAssertEqual(subject(heard.first?.keys, bad: ["bundle"]), [], "with nothing in the payload")
        XCTAssertEqual(heard.first?.onMain, true, "posted to main")
        XCTAssertTrue(subject(heard.first?.taken == bundle, bad: false),
                      "the bundle was already kept when the page was told, and its user's refresh got it")
        XCTAssertTrue(RecoverySheet.takeOrphanedBundle(userId: testUserId) == nil, "nothing is left after that refresh")
    }

    func testNothingKeptMeansThePageIsToldNothing() {
        guard let holder = makeEngine(provision: true) else {
            return
        }
        let recorder = recordBundleWaiting()
        // A flow whose page never went away: the call that asked got the bundle.
        guard createBackup(on: holder) != nil else {
            return
        }
        // A sheet that outlived its page and was then torn down by a wipe:
        // couriered on the close (F3), never kept.
        guard let flow = runToCode() else {
            return
        }
        RecoverySheet.teardownForNavigation()
        spinMain(0.3)
        XCTAssertEqual(stage, "code", "the sheet survived the page load")
        RecoverySheet.teardown()
        assertBundle(result(of: flow), "full teardown after a page load")
        spinMain(0.5)
        XCTAssertEqual(subject(recorder.all.count, bad: 1), 0, "no bundle was kept, so no event was sent")
    }

    func testWipeTeardownClearsABundleKeptForItsOwnUser() {
        guard let holder = makeEngine(provision: true) else {
            return
        }
        use(holder)
        let recorder = recordBundleWaiting()
        guard runSurvivingNavigation() != nil else {
            return
        }
        RecoverySheet.teardown()
        let kept = subject(RecoverySheet.takeOrphanedBundle(userId: testUserId), bad: "{}")
        XCTAssertTrue(kept == nil, "teardown() dropped it, even for the user it was kept for")
        spinMain(0.5)
        XCTAssertEqual(subject(recorder.all.count, bad: 0), 1, "told once when it was kept; the teardown sent nothing")
    }

    /// The wiring itself: the app's plugin installed a hook when Capacitor
    /// loaded it, and load() installs one that reaches the plugin's
    /// listeners with an empty payload without keeping the plugin alive.
    func testPluginLoadInstallsAWeakHookThatSendsAnEmptyEvent() {
        XCTAssertTrue(subject(hookSaved && savedHook != nil, bad: false),
                      "the app's E2ee plugin installed the hook when Capacitor loaded it")
        let recorder = SettleRecorder()
        weak var released: E2eePlugin?
        autoreleasepool {
            let plugin = E2eePlugin()
            // A bridge sets this in load(on:); a bare instance has none.
            plugin.eventListeners = NSMutableDictionary()
            plugin.load()
            let options: [String: Any] = ["eventName": bundleWaitingEvent]
            let jsOptions = JSTypes.coerceDictionaryToJSObject(options as NSDictionary, formattingDatesAsStrings: true) ?? [:]
            let made: CAPPluginCall? = CAPPluginCall(
                callbackId: "t8-\(UUID().uuidString)",
                methodName: "addListener",
                options: jsOptions,
                success: { result, _ in
                    let data = result?.data ?? [:]
                    recorder.record(.init(keys: data.keys.sorted(), json: nil, reject: nil))
                },
                error: { error in
                    recorder.record(.init(keys: [], json: nil, reject: error?.message ?? "<nil error>"))
                }
            )
            guard let listener = made else {
                XCTFail("CAPPluginCall init returned nil")
                return
            }
            plugin.addListener(listener)
            RecoverySheet.bundleWaitingHook?()
            waitOnMain("the listener heard the event", timeout: 10) { !recorder.all.isEmpty }
            released = plugin
        }
        spinMain(0.3)
        let heard = recorder.all
        XCTAssertEqual(subject(heard.count, bad: 0), 1, "one event for one call of the hook")
        XCTAssertNil(heard.first?.reject, "delivered as an event, not an error")
        XCTAssertEqual(subject(heard.first?.keys, bad: ["bundle"]), [], "with nothing in the payload")
        XCTAssertTrue(subject(released == nil, bad: false), "the hook does not keep the plugin alive")
        // The hook now points at a released plugin: a no-op, never a crash.
        RecoverySheet.bundleWaitingHook?()
        spinMain(0.3)
        XCTAssertEqual(recorder.all.count, 1, "a released plugin sends nothing")
    }

    // MARK: 8. hasActiveFlow keeps consent alerts off the sheet

    func testHasActiveFlowSpansTheFlowAndKeepsConsentAlertsOff() {
        guard let holder = makeEngine(provision: true), let root = root else {
            return
        }
        use(holder)
        XCTAssertFalse(subject(RecoverySheet.hasActiveFlow, bad: true), "no flow yet")
        // A presenter of its own whose host is whatever the test points it
        // at: the sheet while it is up, so only hasActiveFlow can refuse
        // (the sheet itself is presenting nothing and is in a window).
        let host = HostRef()
        let presenter = NativeConfirmPresenter(presenter: { host.controller }, enableDelay: 0.2, timeout: 10)
        let payload = ConfirmPayload(
            title: "T8 sheet check",
            message: "Must not appear over a recovery sheet.",
            confirmLabel: "OK",
            cancelLabel: "Cancel",
            kind: "info",
            defaultButton: "cancel"
        )
        let confirmRefused = { (what: String) in
            let answer = startOffMain("consent") { () -> Bool in
                dispatchPrecondition(condition: .notOnQueue(.main))
                return try presenter.confirm(req: payload)
            }
            self.running.append { answer.value != nil }
            // Well under the presenter's 10 s timeout: a refusal is immediate.
            let settled = self.waitOnMain("\(what): the consent call returned", timeout: 5) { answer.value != nil }
            var value: Bool?
            if case .success(let answered)? = answer.value {
                value = answered
            }
            XCTAssertTrue(settled && subject(value == false, bad: false), "\(what): confirm answers false")
            let stacked = ui { () -> Bool in
                presenter.presentedAlertForTesting != nil || root.presentedViewController?.presentedViewController != nil
            }
            XCTAssertFalse(subject(stacked, bad: true), "\(what): nothing was presented over the sheet")
        }

        let flow = startCreate()
        guard waitForStage("intro") else {
            return
        }
        XCTAssertTrue(subject(RecoverySheet.hasActiveFlow, bad: false), "true while the intro is up")
        ui { () -> Void in host.controller = root.presentedViewController }
        confirmRefused("intro")

        tap("create")
        guard waitForStage("code") else {
            return
        }
        XCTAssertTrue(subject(RecoverySheet.hasActiveFlow, bad: false), "true while the code is up")
        confirmRefused("code")

        tap("saved")
        assertBundle(result(of: flow), "I saved it")
        // The flow returns only after its sheet has gone and the claim is released.
        XCTAssertFalse(subject(RecoverySheet.hasActiveFlow, bad: true), "false once the flow has ended")
        XCTAssertFalse(sheetOnScreen, "and the sheet is gone")

        // Positive control: the same presenter does show its alert once no
        // flow is active, so the refusals above came from the flow.
        ui { () -> Void in host.controller = root }
        let answer = startOffMain("consent control") { () -> Bool in
            dispatchPrecondition(condition: .notOnQueue(.main))
            return try presenter.confirm(req: payload)
        }
        running.append { answer.value != nil }
        let shown = waitOnMain("the control alert is on screen", timeout: 5) {
            ui { presenter.presentedAlertForTesting != nil }
        }
        XCTAssertTrue(shown, "with no active flow the alert is presented")
        ui { presenter.completeForTesting(confirmed: false) }
        waitOnMain("the control consent call returned") { answer.value != nil }
        if case .success(let value)? = answer.value {
            XCTAssertFalse(value, "the cancelled control alert answers false")
        } else {
            XCTFail("the control consent call did not answer")
        }
        waitOnMain("the control alert is gone") { ui { root.presentedViewController == nil } }
    }
}
