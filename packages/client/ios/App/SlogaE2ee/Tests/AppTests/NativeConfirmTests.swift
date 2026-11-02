// NativeConfirmTests.swift: gate G9, the consent-dialog part (IE plan D1
// "Blocking-prompt safety", D5 "NativeConfirm"), plus W2 carry-in m7 (a
// throwing NativeConfirm through the real uniffi ABI).
//
// Each test builds its own NativeConfirmPresenter over the app's root view
// controller, calls `confirm` on a background thread (as the engine does)
// and drives the alert from main through the presenter's test hooks. The m7
// tests run a real E2eeEngine on a fresh temp directory with a fake confirm
// that never touches UIKit.
import AcutestE2eeBindings
import Foundation
import Security
import UIKit
import XCTest
@testable import SlogaE2ee

// MARK: - Shared helpers (nonisolated: some run on background threads)

/// Runs `body` on main with UIKit's isolation. Test methods run on main.
private func ui<T: Sendable>(_ body: @MainActor () -> T) -> T {
    dispatchPrecondition(condition: .onQueue(.main))
    return MainActor.assumeIsolated(body)
}

/// A thread-safe counter (how often a presenter closure was consulted).
private final class Counter: @unchecked Sendable {
    private let lock = NSLock()
    private var count = 0

    func bump() {
        lock.lock()
        count += 1
        lock.unlock()
    }

    var value: Int {
        lock.lock()
        defer { lock.unlock() }
        return count
    }
}

/// A list appended to from background threads and read on main.
private final class LockedList<Element>: @unchecked Sendable {
    private let lock = NSLock()
    private var items: [Element] = []

    func append(_ item: Element) {
        lock.lock()
        items.append(item)
        lock.unlock()
    }

    var all: [Element] {
        lock.lock()
        defer { lock.unlock() }
        return items
    }
}

/// The answer of one background `confirm` call, and how long it took.
private final class AnswerBox: @unchecked Sendable {
    private let lock = NSLock()
    private var result: Result<Bool, Error>?
    private var started: Date?
    private var finished: Date?

    func start() {
        lock.lock()
        started = Date()
        lock.unlock()
    }

    func finish(_ value: Result<Bool, Error>) {
        lock.lock()
        result = value
        finished = Date()
        lock.unlock()
    }

    /// The answer; nil while pending (or if `confirm` threw, see `threw`).
    var bool: Bool? {
        lock.lock()
        defer { lock.unlock() }
        if case .success(let value)? = result {
            return value
        }
        return nil
    }

    var threw: Bool {
        lock.lock()
        defer { lock.unlock() }
        if case .failure? = result {
            return true
        }
        return false
    }

    /// Seconds from the call to its answer; nil while pending.
    var elapsed: TimeInterval? {
        lock.lock()
        defer { lock.unlock() }
        guard let started = started, let finished = finished else {
            return nil
        }
        return finished.timeIntervalSince(started)
    }
}

/// Call `presenter.confirm(req:)` on a new background thread, the way an
/// engine thread would, and fulfill `done` when it returns.
private func startConfirm(
    _ presenter: NativeConfirmPresenter,
    _ req: ConfirmPayload,
    done: XCTestExpectation
) -> AnswerBox {
    let box = AnswerBox()
    box.start()
    let thread = Thread {
        let result = Result { try presenter.confirm(req: req) }
        box.finish(result)
        done.fulfill()
    }
    thread.name = "T3.confirm"
    thread.start()
    return box
}

private func payload(
    title: String = "T3 consent title",
    message: String = "T3 consent message.\n\nProceed?",
    confirmLabel: String = "T3 Confirm",
    cancelLabel: String = "T3 Cancel",
    kind: String = "warning",
    defaultButton: String = "cancel"
) -> ConfirmPayload {
    ConfirmPayload(
        title: title,
        message: message,
        confirmLabel: confirmLabel,
        cancelLabel: cancelLabel,
        kind: kind,
        defaultButton: defaultButton
    )
}

private func jsonObject(_ text: String?) -> NSDictionary? {
    guard let data = text?.data(using: .utf8) else {
        return nil
    }
    return (try? JSONSerialization.jsonObject(with: data)) as? NSDictionary
}

/// A consent request on screen: the alert, and the waiting caller's answer.
private struct Pending {
    let alert: UIAlertController
    let box: AnswerBox
    let done: XCTestExpectation
}

/// What one alert rendered, read on main.
private struct Rendered: Sendable {
    var title: String?
    var message: String?
    var isAlertStyle = false
    var actionCount = 0
    var cancelCount = 0
    var cancelTitle: String?
    var confirmTitle: String?
    var confirmStyle: Int?
    var confirmEnabled = true
    var preferred = "none"
}

// MARK: - m7 fakes (the real ABI; never UIKit)

private struct ArbitrarySwiftError: Error {}

/// A NativeConfirm that answers without any UI and records what it was asked.
private final class FakeConfirm: NativeConfirm, @unchecked Sendable {
    enum Mode {
        case throwConfirmFailed
        case throwArbitrary
        case returnFalse
        case returnTrue
    }

    private let mode: Mode
    private let lock = NSLock()
    private var seen: [ConfirmPayload] = []
    private var sawMain = false

    init(_ mode: Mode) {
        self.mode = mode
    }

    var payloads: [ConfirmPayload] {
        lock.lock()
        defer { lock.unlock() }
        return seen
    }

    var calledOnMain: Bool {
        lock.lock()
        defer { lock.unlock() }
        return sawMain
    }

    func confirm(req: ConfirmPayload) throws -> Bool {
        lock.lock()
        seen.append(req)
        if Thread.isMainThread {
            sawMain = true
        }
        lock.unlock()
        switch mode {
        case .throwConfirmFailed:
            throw ConfirmError.Failed
        case .throwArbitrary:
            throw ArbitrarySwiftError()
        case .returnFalse:
            return false
        case .returnTrue:
            return true
        }
    }
}

private struct WipeReport {
    var setupError: String?
    var provisionedBefore: Bool?
    var storeFilesBefore: [String] = []
    var confirmCallsBeforeWipe = -1
    var wipeReturned = false
    var wipeError: Error?
    var provisionedAfter: Bool?
    var statusAfter: String?
    var storeFilesAfter: [String] = []
}

private final class ReportBox: @unchecked Sendable {
    private let lock = NSLock()
    private var stored: WipeReport?

    func set(_ report: WipeReport) {
        lock.lock()
        stored = report
        lock.unlock()
    }

    var report: WipeReport? {
        lock.lock()
        defer { lock.unlock() }
        return stored
    }
}

private func storeFiles(in dir: URL) -> [String] {
    ["store.db", "master.key"].filter {
        FileManager.default.fileExists(atPath: dir.appendingPathComponent($0).path)
    }
}

/// Deletes the production wrap-key item (ios_keychain.rs PRODUCTION
/// identity), any sync state. Simulator only: on a device this item guards
/// the real store.
private func deleteProductionWrapItem() -> OSStatus {
    let query: [String: Any] = [
        kSecClass as String: kSecClassGenericPassword,
        kSecAttrService as String: "gg.sloga.app.e2ee",
        kSecAttrAccount as String: "e2ee-master-wrap",
        kSecAttrAccessGroup as String: "M6UUDLK2XQ.gg.sloga.app.e2ee",
        kSecAttrSynchronizable as String: kSecAttrSynchronizableAny,
    ]
    return SecItemDelete(query as CFDictionary)
}

/// m7 provisions through the real protector, so its outcome must not
/// depend on a wrap item an earlier run left behind: start from none (the
/// add path) and remove the one this test planted. Device: skip.
private func isolateWrapItemForM7(_ test: XCTestCase) throws {
    #if targetEnvironment(simulator)
    let cleared = deleteProductionWrapItem()
    XCTAssertTrue(
        cleared == errSecSuccess || cleared == errSecItemNotFound,
        "could not clear the wrap item before m7 (status \(cleared))"
    )
    test.addTeardownBlock {
        _ = deleteProductionWrapItem()
    }
    #else
    throw XCTSkip("m7 deletes the production keychain item; Simulator only")
    #endif
}

/// Provision a fresh store, then wipe it through `confirm`. Off main only.
private func runWipeScenario(dir: URL, confirm: FakeConfirm) -> WipeReport {
    dispatchPrecondition(condition: .notOnQueue(.main))
    var report = WipeReport()
    do {
        let engine = try E2eeEngine(storeDir: dir.path, confirm: confirm)
        _ = try engine.enable()
        report.provisionedBefore = try engine.isProvisioned()
        report.storeFilesBefore = storeFiles(in: dir)
        report.confirmCallsBeforeWipe = confirm.payloads.count
        do {
            try engine.wipe()
            report.wipeReturned = true
        } catch {
            report.wipeError = error
        }
        // is_provisioned only looks at files; it never reopens the store.
        report.provisionedAfter = try engine.isProvisioned()
        if !report.wipeReturned {
            // Only after a decline: status() on a wiped dir would provision.
            report.statusAfter = try engine.status()
        }
    } catch {
        report.setupError = rejectJson(for: error)
    }
    // The engine is released by here, before the caller deletes the dir.
    report.storeFilesAfter = storeFiles(in: dir)
    return report
}

// MARK: - Tests

final class NativeConfirmTests: XCTestCase {
    private var root: UIViewController?

    @MainActor private static func appRootViewController() -> UIViewController? {
        let windows = UIApplication.shared.connectedScenes
            .compactMap { $0 as? UIWindowScene }
            .flatMap { $0.windows }
        return (windows.first { $0.isKeyWindow } ?? windows.first)?.rootViewController
    }

    override func setUp() {
        super.setUp()
        var found: UIViewController?
        waitOnMain("the app has a root view controller in a window", timeout: 20) {
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
        // A leftover presentation would make every presenter refuse to stack.
        waitOnMain("the root view controller is not presenting anything") {
            ui { root.presentedViewController == nil }
        }
    }

    override func tearDown() {
        if let root = root {
            let clean = waitOnMain("no alert is left on screen after the test") {
                ui { root.presentedViewController == nil }
            }
            if !clean {
                // Keep the next test's precondition intact.
                ui { () -> Void in root.presentedViewController?.dismiss(animated: false) }
            }
        }
        root = nil
        super.tearDown()
    }

    // MARK: Main-thread helpers

    /// Polls `condition` on main, running the main run loop in between so
    /// queued main blocks (presentation, dismissal) make progress.
    @discardableResult
    private func waitOnMain(
        _ what: String,
        timeout: TimeInterval = 10,
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

    /// Lets main run for `seconds` (anything a bug would queue gets to run).
    private func spinMain(_ seconds: TimeInterval) {
        dispatchPrecondition(condition: .onQueue(.main))
        let end = Date(timeIntervalSinceNow: seconds)
        while Date() < end {
            _ = RunLoop.current.run(mode: .default, before: end)
        }
    }

    private func makePresenter(
        enableDelay: TimeInterval = 0.2,
        timeout: TimeInterval = 20,
        counter: Counter? = nil
    ) -> NativeConfirmPresenter? {
        guard let root = root else {
            XCTFail("no root view controller")
            return nil
        }
        return NativeConfirmPresenter(
            presenter: { [weak root] in
                counter?.bump()
                return root
            },
            enableDelay: enableDelay,
            timeout: timeout
        )
    }

    /// Start a confirm off main and wait until its alert is on screen.
    private func present(
        _ presenter: NativeConfirmPresenter,
        _ req: ConfirmPayload,
        file: StaticString = #filePath,
        line: UInt = #line
    ) -> Pending? {
        let done = expectation(description: "confirm answered")
        let box = startConfirm(presenter, req, done: done)
        var shown: UIAlertController?
        let ok = waitOnMain("the consent alert is presented", file: file, line: line) {
            shown = presenter.presentedAlertForTesting
            return shown != nil
        }
        guard ok, let alert = shown else {
            // Release the waiting thread so it cannot outlive the test.
            presenter.declineAll()
            wait(for: [done], timeout: 15)
            return nil
        }
        return Pending(alert: alert, box: box, done: done)
    }

    private func answer(
        _ pending: Pending,
        timeout: TimeInterval = 10,
        file: StaticString = #filePath,
        line: UInt = #line
    ) -> Bool? {
        wait(for: [pending.done], timeout: timeout)
        XCTAssertFalse(pending.box.threw, "NativeConfirmPresenter.confirm never throws", file: file, line: line)
        return pending.box.bool
    }

    /// The alert is off screen and nothing is presented over the root.
    private func isGone(_ alert: UIAlertController) -> Bool {
        let root = self.root
        return ui { alert.presentingViewController == nil && root?.presentedViewController == nil }
    }

    /// The (only) non-cancel action is enabled.
    private func confirmEnabled(_ alert: UIAlertController) -> Bool {
        ui { alert.actions.first { $0.style != .cancel }?.isEnabled == true }
    }

    private func rendered(_ alert: UIAlertController) -> Rendered {
        ui { () -> Rendered in
            var r = Rendered()
            r.title = alert.title
            r.message = alert.message
            r.isAlertStyle = alert.preferredStyle == .alert
            r.actionCount = alert.actions.count
            let cancels = alert.actions.filter { $0.style == .cancel }
            let confirms = alert.actions.filter { $0.style != .cancel }
            r.cancelCount = cancels.count
            r.cancelTitle = cancels.first?.title
            r.confirmTitle = confirms.first?.title
            r.confirmStyle = confirms.first?.style.rawValue
            r.confirmEnabled = confirms.first?.isEnabled ?? true
            if let preferred = alert.preferredAction {
                if preferred === cancels.first {
                    r.preferred = "cancel"
                } else if preferred === confirms.first {
                    r.preferred = "confirm"
                } else {
                    r.preferred = "other"
                }
            }
            return r
        }
    }

    // MARK: ConsentSettlement

    func testSettlementFirstSettleWinsAndLaterSettlesReturnFalse() {
        let settlement = ConsentSettlement()
        XCTAssertNil(settlement.wait(timeout: 0), "an unsettled settlement has no value")
        XCTAssertTrue(settlement.settle(false), "the first settle wins")
        XCTAssertFalse(settlement.settle(true), "a later settle (a late tap) is refused")
        XCTAssertFalse(settlement.settle(false), "a later settle of the same value is refused too")
        XCTAssertEqual(settlement.wait(timeout: 0), false, "wait returns the first answer, unflipped")

        let accepted = ConsentSettlement()
        XCTAssertTrue(accepted.settle(true), "first settle on a fresh settlement wins")
        XCTAssertFalse(accepted.settle(false), "a decline after consent cannot flip it")
        XCTAssertEqual(accepted.wait(timeout: 0), true, "wait returns true when true settled first")
    }

    func testSettlementConcurrentSettlersExactlyOneWins() {
        let settlement = ConsentSettlement()
        let won = LockedList<Bool>()
        DispatchQueue.concurrentPerform(iterations: 32) { index in
            let value = index % 2 == 0
            if settlement.settle(value) {
                won.append(value)
            }
        }
        let winners = won.all
        XCTAssertEqual(winners.count, 1, "exactly one of 32 concurrent settles wins")
        XCTAssertEqual(settlement.wait(timeout: 0), winners.first, "the recorded value is the winner's")
    }

    func testSettlementWaitReturnsValueSettledFromAnotherThread() {
        let settlement = ConsentSettlement()
        // Main polls this flag instead of blocking on a semaphore the waiter
        // signals (a priority inversion the Thread Performance Checker flags).
        let entered = LockedList<Bool>()
        let done = expectation(description: "waiter returned")
        let box = AnswerBox()
        let waiter = Thread {
            box.start()
            entered.append(true)
            if let value = settlement.wait(timeout: 10) {
                box.finish(.success(value))
            } else {
                // Timed out: recorded as a failure, so `bool` stays nil.
                box.finish(.failure(ArbitrarySwiftError()))
            }
            done.fulfill()
        }
        waiter.start()
        waitOnMain("the waiter thread started", timeout: 5) { !entered.all.isEmpty }
        spinMain(0.2)
        XCTAssertNil(box.bool, "the waiter blocks while unsettled")
        XCTAssertTrue(settlement.settle(true), "main settles the pending wait")
        wait(for: [done], timeout: 10)
        XCTAssertEqual(box.bool, true, "wait returns the value settled from another thread")
        XCTAssertLessThan(box.elapsed ?? .infinity, 5, "the waiter woke on settle, not on its timeout")
    }

    func testSettlementWaitTimesOutToNil() {
        let done = expectation(description: "bounded waits returned")
        let rows = LockedList<(timedOut: Bool, took: TimeInterval)>()
        Thread {
            for timeout in [0.3, -5, .nan, .infinity] as [TimeInterval] {
                let settlement = ConsentSettlement()
                let start = Date()
                let value = settlement.wait(timeout: timeout)
                rows.append((timedOut: value == nil, took: Date().timeIntervalSince(start)))
            }
            done.fulfill()
        }.start()
        // A wait that ignored its bound would never return: this expectation is the guard.
        wait(for: [done], timeout: 10)
        let got = rows.all
        XCTAssertEqual(got.count, 4, "every bounded wait returned")
        guard got.count == 4 else {
            return
        }
        let timedOut = got.map { $0.timedOut }
        let took = got.map { $0.took }
        XCTAssertEqual(timedOut, [true, true, true, true], "an unsettled wait times out to nil")
        XCTAssertGreaterThanOrEqual(took[0], 0.25, "a 0.3 s wait waits about 0.3 s")
        XCTAssertLessThan(took[0], 5, "a 0.3 s wait returns after its timeout")
        // Negative, NaN and infinite timeouts are bounded to an immediate return.
        XCTAssertLessThan(took[1], 1, "a negative timeout returns at once")
        XCTAssertLessThan(took[2], 1, "a NaN timeout returns at once")
        XCTAssertLessThan(took[3], 1, "an infinite timeout is bounded, not a forever wait")
    }

    // MARK: Answers

    func testConfirmButtonAnswersTrueAndDismisses() {
        guard let presenter = makePresenter(enableDelay: 0.2),
              let session = present(presenter, payload(title: "T3 confirm button"))
        else {
            return
        }
        XCTAssertFalse(isGone(session.alert), "the alert is on screen before it is answered")
        waitOnMain("confirm enabled after enableDelay") { confirmEnabled(session.alert) }
        presenter.completeForTesting(confirmed: true)
        XCTAssertEqual(answer(session), true, "the confirm button answers true")
        waitOnMain("the answered alert is dismissed") { isGone(session.alert) }
        XCTAssertNil(presenter.presentedAlertForTesting, "nothing is open after the answer")
    }

    func testCancelButtonAnswersFalseAndDismissesEvenDuringEnableDelay() {
        guard let presenter = makePresenter(enableDelay: 5),
              let session = present(presenter, payload(title: "T3 cancel button"))
        else {
            return
        }
        XCTAssertFalse(confirmEnabled(session.alert), "still inside the enable delay")
        presenter.completeForTesting(confirmed: false)
        XCTAssertEqual(answer(session), false, "the cancel button answers false")
        waitOnMain("the cancelled alert is dismissed") { isGone(session.alert) }
    }

    func testDeclineAllAnswersFalseDismissesAndFreesTheSlot() {
        guard let presenter = makePresenter(enableDelay: 0.2) else {
            return
        }
        // Nothing open: a no-op.
        presenter.declineAll()
        guard let session = present(presenter, payload(title: "T3 decline all")) else {
            return
        }
        XCTAssertFalse(isGone(session.alert), "the alert is on screen before teardown")
        presenter.declineAll()
        XCTAssertNil(presenter.presentedAlertForTesting, "declineAll settles at once, before main dismisses")
        XCTAssertEqual(answer(session), false, "declineAll answers false")
        waitOnMain("the declined alert is dismissed") { isGone(session.alert) }

        // The slot was released: the next request is presented normally.
        guard let next = present(presenter, payload(title: "T3 after decline all")) else {
            return
        }
        presenter.completeForTesting(confirmed: false)
        XCTAssertEqual(answer(next), false, "the request after a declineAll answers its own cancel")
        waitOnMain("the second alert is dismissed") { isGone(next.alert) }
    }

    func testTimeoutAnswersFalseAndDismisses() {
        guard let presenter = makePresenter(enableDelay: 0.2, timeout: 1.5),
              let session = present(presenter, payload(title: "T3 timeout"))
        else {
            return
        }
        XCTAssertFalse(isGone(session.alert), "the alert is on screen before the timeout")
        XCTAssertEqual(answer(session, timeout: 15), false, "an unanswered dialog times out to false")
        XCTAssertGreaterThanOrEqual(session.box.elapsed ?? 0, 1.4, "the decline came from the timeout, not earlier")
        waitOnMain("the timed-out alert is dismissed") { isGone(session.alert) }
        // A tap after the timeout has nothing to act on.
        presenter.completeForTesting(confirmed: true)
        XCTAssertEqual(session.box.bool, false, "a late tap cannot flip the timed-out answer")
    }

    func testPresenterReturningNilAnswersFalseWithNothingPresented() {
        let calls = Counter()
        let presenter = NativeConfirmPresenter(
            presenter: {
                calls.bump()
                return nil
            },
            enableDelay: 0.2,
            timeout: 20
        )
        let done = expectation(description: "confirm answered")
        let box = startConfirm(presenter, payload(title: "T3 nil presenter"), done: done)
        wait(for: [done], timeout: 5)
        XCTAssertEqual(box.bool, false, "no view controller to present on answers false")
        XCTAssertLessThan(box.elapsed ?? .infinity, 5, "a presentation failure answers at once, not on timeout")
        XCTAssertEqual(calls.value, 1, "the decline came from the presentation path (presenter consulted once)")
        spinMain(0.3)
        let root = self.root
        XCTAssertTrue(ui { root?.presentedViewController == nil }, "nothing was presented")
    }

    func testHostOutsideAWindowAnswersFalseWithNothingPresented() {
        let calls = Counter()
        let detached = ui { UIViewController() }
        let presenter = NativeConfirmPresenter(
            presenter: {
                calls.bump()
                return detached
            },
            enableDelay: 0.2,
            timeout: 20
        )
        let done = expectation(description: "confirm answered")
        let box = startConfirm(presenter, payload(title: "T3 detached host"), done: done)
        wait(for: [done], timeout: 5)
        XCTAssertEqual(box.bool, false, "a host that is not in a window answers false")
        XCTAssertEqual(calls.value, 1, "the presenter was consulted once")
        spinMain(0.3)
        let root = self.root
        XCTAssertTrue(ui { detached.presentedViewController == nil }, "nothing was presented on the detached host")
        XCTAssertTrue(ui { root?.presentedViewController == nil }, "nothing was presented on the root")
    }

    func testSecondConfirmWhilePresentedIsRefusedAndFirstStillAnswers() {
        let calls = Counter()
        guard let presenter = makePresenter(enableDelay: 0.2, counter: calls),
              let first = present(presenter, payload(title: "T3 first request"))
        else {
            return
        }
        let secondDone = expectation(description: "second confirm answered")
        let second = startConfirm(presenter, payload(title: "T3 second request"), done: secondDone)
        wait(for: [secondDone], timeout: 5)
        XCTAssertEqual(second.bool, false, "a second confirm while one is presented answers false")
        XCTAssertLessThan(second.elapsed ?? .infinity, 2, "the second request is refused at once")
        spinMain(0.3)
        XCTAssertEqual(calls.value, 1, "the second request never reached the presenter")
        let root = self.root
        let firstStillUp = ui { root?.presentedViewController === first.alert }
        XCTAssertTrue(firstStillUp, "the first alert is still the one on screen")
        XCTAssertTrue(presenter.presentedAlertForTesting === first.alert, "the slot still holds the first request")
        XCTAssertNil(first.box.bool, "the refused second request did not answer the first")

        waitOnMain("first confirm enabled") { confirmEnabled(first.alert) }
        presenter.completeForTesting(confirmed: true)
        XCTAssertEqual(answer(first), true, "the first alert still answers its own confirm")
        waitOnMain("the first alert is dismissed") { isGone(first.alert) }
    }

    func testUnrenderablePayloadIsDeclinedWithoutPresenting() {
        let calls = Counter()
        guard let presenter = makePresenter(enableDelay: 0.2, counter: calls) else {
            return
        }
        let bad: [(String, ConfirmPayload)] = [
            ("empty title", payload(title: "")),
            ("whitespace title", payload(title: " \n\t ")),
            ("empty message", payload(message: "")),
            ("whitespace message", payload(message: "\n\n")),
            ("empty confirm label", payload(confirmLabel: "")),
            ("whitespace cancel label", payload(cancelLabel: "  ")),
            ("empty kind", payload(kind: "")),
            ("unknown kind", payload(kind: "danger")),
            ("wrong-case kind", payload(kind: "Warning")),
            ("empty defaultButton", payload(defaultButton: "")),
            ("unknown defaultButton", payload(defaultButton: "none")),
            ("wrong-case defaultButton", payload(defaultButton: "Confirm")),
        ]
        let done = expectation(description: "all unrenderable confirms answered")
        let answers = LockedList<Bool?>()
        let requests = bad.map { $0.1 }
        Thread {
            for req in requests {
                answers.append(try? presenter.confirm(req: req))
            }
            done.fulfill()
        }.start()
        wait(for: [done], timeout: 10)
        let got = answers.all
        XCTAssertEqual(got.count, bad.count, "every unrenderable request answered")
        for (index, (name, _)) in bad.enumerated() where index < got.count {
            XCTAssertEqual(got[index], false, "\(name) must be declined")
        }
        spinMain(0.3)
        XCTAssertEqual(calls.value, 0, "no unrenderable payload reached the presenter")
        let root = self.root
        XCTAssertTrue(ui { root?.presentedViewController == nil }, "nothing was presented for bad copy")

        // Positive control through the same presenter: valid copy IS presented.
        guard let session = present(presenter, payload(title: "T3 valid copy")) else {
            return
        }
        XCTAssertEqual(calls.value, 1, "valid copy reaches the presenter")
        presenter.completeForTesting(confirmed: false)
        XCTAssertEqual(answer(session), false, "the valid-copy control cancels to false")
        waitOnMain("the control alert is dismissed") { isGone(session.alert) }
    }

    func testConfirmIgnoredUntilEnableDelayElapses() {
        guard let presenter = makePresenter(enableDelay: 1.5),
              let session = present(presenter, payload(title: "T3 enable delay"))
        else {
            return
        }
        let shownAt = Date()
        XCTAssertFalse(confirmEnabled(session.alert), "the confirm action starts disabled")
        presenter.completeForTesting(confirmed: true)
        spinMain(0.3)
        XCTAssertNil(session.box.bool, "a confirm inside enableDelay is ignored (still pending)")
        XCTAssertTrue(presenter.presentedAlertForTesting === session.alert, "the alert stays up after the early tap")

        waitOnMain("confirm enabled after enableDelay") { confirmEnabled(session.alert) }
        XCTAssertGreaterThanOrEqual(Date().timeIntervalSince(shownAt), 1.3, "the confirm stayed disabled for enableDelay")
        presenter.completeForTesting(confirmed: true)
        XCTAssertEqual(answer(session), true, "a confirm after enableDelay answers true")
        waitOnMain("the confirmed alert is dismissed") { isGone(session.alert) }
    }

    // MARK: Rendering

    private func assertRendering(
        _ req: ConfirmPayload,
        confirmStyle: UIAlertAction.Style,
        preferred: String,
        file: StaticString = #filePath,
        line: UInt = #line
    ) {
        // A long enable delay keeps the confirm disabled while we read it.
        guard let presenter = makePresenter(enableDelay: 5),
              let session = present(presenter, req, file: file, line: line)
        else {
            return
        }
        let r = rendered(session.alert)
        let tag = "[\(req.kind)/\(req.defaultButton)]"
        XCTAssertTrue(r.isAlertStyle, "\(tag) presented as an alert", file: file, line: line)
        XCTAssertEqual(r.title, req.title, "\(tag) title rendered verbatim", file: file, line: line)
        XCTAssertEqual(r.message, req.message, "\(tag) message rendered verbatim", file: file, line: line)
        XCTAssertEqual(r.actionCount, 2, "\(tag) exactly two buttons", file: file, line: line)
        XCTAssertEqual(r.cancelCount, 1, "\(tag) exactly one .cancel-style action", file: file, line: line)
        XCTAssertEqual(r.cancelTitle, req.cancelLabel, "\(tag) the .cancel action carries the cancel label", file: file, line: line)
        XCTAssertEqual(r.confirmTitle, req.confirmLabel, "\(tag) confirm label rendered verbatim", file: file, line: line)
        XCTAssertEqual(r.confirmStyle, confirmStyle.rawValue, "\(tag) confirm style", file: file, line: line)
        XCTAssertFalse(r.confirmEnabled, "\(tag) confirm starts disabled", file: file, line: line)
        XCTAssertEqual(r.preferred, preferred, "\(tag) preferredAction follows defaultButton", file: file, line: line)

        presenter.completeForTesting(confirmed: false)
        XCTAssertEqual(answer(session, file: file, line: line), false, "\(tag) rendering probe cancels", file: file, line: line)
        waitOnMain("the rendering probe is dismissed", file: file, line: line) { isGone(session.alert) }
    }

    func testWarningRendersDestructiveConfirmWithCancelPreferred() {
        // Core's real Wipe copy (shell.rs ConfirmRequest::Wipe).
        assertRendering(
            payload(
                title: "Log out and destroy encrypted data",
                message: "This permanently destroys the encrypted message history and encryption keys "
                    + "stored on THIS device. Messages that were only delivered here cannot be "
                    + "recovered.\n\nDestroy encrypted data?",
                confirmLabel: "Destroy",
                cancelLabel: "Cancel",
                kind: "warning",
                defaultButton: "cancel"
            ),
            confirmStyle: .destructive,
            preferred: "cancel"
        )
    }

    func testInfoRendersDefaultConfirmWithConfirmPreferred() {
        assertRendering(
            payload(
                title: "  Mark Alice's device as verified? ",
                message: "  Compare the safety number.\n\n12345 67890 12345  \n",
                confirmLabel: "Mark verified",
                cancelLabel: "Not now",
                kind: "info",
                defaultButton: "confirm"
            ),
            confirmStyle: .default,
            preferred: "confirm"
        )
    }

    func testWarningWithConfirmPreferredKeepsDestructiveStyle() {
        assertRendering(
            payload(title: "T3 warning, confirm preferred", kind: "warning", defaultButton: "confirm"),
            confirmStyle: .destructive,
            preferred: "confirm"
        )
    }

    func testInfoWithCancelPreferredKeepsDefaultStyle() {
        assertRendering(
            payload(title: "T3 info, cancel preferred", kind: "info", defaultButton: "cancel"),
            confirmStyle: .default,
            preferred: "cancel"
        )
    }

    // MARK: Removal from outside, re-appearance, isBusy (Stage 5 m1)

    func testAlertDismissedFromOutsideAnswersFalsePromptly() {
        // A long timeout: only the removal path can answer inside the bound.
        guard let presenter = makePresenter(enableDelay: 0.2, timeout: 60),
              let session = present(presenter, payload(title: "T3 removed from outside")),
              let root = root
        else {
            return
        }
        let removedAt = Date()
        // What another presenter (recovery sheet, folder picker) does when it
        // dismisses whatever its host presented: the alert goes with it.
        ui { () -> Void in root.dismiss(animated: true) }
        XCTAssertEqual(answer(session, timeout: 5), false, "an alert removed from outside answers false")
        XCTAssertLessThan(Date().timeIntervalSince(removedAt), 5, "the removal answered, not the 60 s timeout")
        waitOnMain("the removed alert is gone") { isGone(session.alert) }
        XCTAssertNil(presenter.presentedAlertForTesting, "nothing is open after the removal")
        XCTAssertFalse(presenter.isBusy, "the slot is free after the removal answered")
    }

    func testTapThatDismissesBeforeItsHandlerStillConfirms() {
        guard let presenter = makePresenter(enableDelay: 0.2, timeout: 60),
              let session = present(presenter, payload(title: "T3 UIKit tap order")),
              let root = root
        else {
            return
        }
        waitOnMain("confirm enabled after enableDelay") { confirmEnabled(session.alert) }
        // A real tap's order: UIKit dismisses the alert first and runs the
        // action handler in the dismissal's completion, after
        // viewDidDisappear. The removal decline must not beat it.
        ui { () -> Void in
            root.dismiss(animated: true) {
                presenter.completeForTesting(confirmed: true)
            }
        }
        XCTAssertEqual(answer(session), true, "a tap whose handler runs after the dismissal still confirms")
        waitOnMain("the confirmed alert is gone") { isGone(session.alert) }
        XCTAssertFalse(presenter.isBusy, "the slot is free after the answer")
    }

    private func assertDelayRestartsAfterCover(
        _ style: UIModalPresentationStyle,
        file: StaticString = #filePath,
        line: UInt = #line
    ) {
        let delay: TimeInterval = 0.6
        guard let presenter = makePresenter(enableDelay: delay, timeout: 60),
              let session = present(presenter, payload(title: "T3 cover \(style.rawValue)"), file: file, line: line)
        else {
            return
        }
        let alert = session.alert
        waitOnMain("confirm enabled before the cover", file: file, line: line) { confirmEnabled(alert) }
        let cover = ui { () -> UIViewController in
            let vc = UIViewController()
            vc.modalPresentationStyle = style
            return vc
        }
        ui { () -> Void in alert.present(cover, animated: false) }
        waitOnMain("the cover is on screen", file: file, line: line) {
            ui { cover.presentingViewController === alert && !cover.isBeingPresented }
        }
        XCTAssertFalse(confirmEnabled(alert), "confirm goes dark while covered", file: file, line: line)
        spinMain(delay * 2)
        XCTAssertFalse(confirmEnabled(alert), "the delay does not run out while covered", file: file, line: line)
        XCTAssertNil(session.box.bool, "being covered is not an answer", file: file, line: line)

        ui { () -> Void in cover.dismiss(animated: false) }
        waitOnMain("the cover is gone", file: file, line: line) {
            ui { alert.presentedViewController == nil && cover.presentingViewController == nil }
        }
        let uncoveredAt = Date()
        XCTAssertFalse(confirmEnabled(alert), "confirm is still disabled right after the alert re-appears", file: file, line: line)
        presenter.completeForTesting(confirmed: true)
        spinMain(0.1)
        XCTAssertNil(session.box.bool, "a confirm right after re-appearance is ignored", file: file, line: line)
        XCTAssertTrue(presenter.presentedAlertForTesting === alert, "the alert is still the open request", file: file, line: line)

        waitOnMain("confirm enabled again after the delay", file: file, line: line) { confirmEnabled(alert) }
        XCTAssertGreaterThanOrEqual(
            Date().timeIntervalSince(uncoveredAt), delay - 0.15,
            "the full delay ran again after the alert re-appeared", file: file, line: line
        )
        presenter.completeForTesting(confirmed: true)
        XCTAssertEqual(answer(session, file: file, line: line), true, "confirm works after the restarted delay", file: file, line: line)
        waitOnMain("the alert is dismissed", file: file, line: line) { isGone(alert) }
    }

    func testEnableDelayRestartsAfterFullScreenCover() {
        // Full screen: the alert disappears and re-appears (viewDidAppear).
        assertDelayRestartsAfterCover(.fullScreen)
    }

    func testEnableDelayRestartsAfterSheetCover() {
        // A sheet gives the alert no appearance callbacks at all.
        assertDelayRestartsAfterCover(.pageSheet)
    }

    func testBecomingActiveRestartsTheEnableDelay() {
        let delay: TimeInterval = 0.6
        guard let presenter = makePresenter(enableDelay: delay, timeout: 60),
              let session = present(presenter, payload(title: "T3 became active"))
        else {
            return
        }
        let alert = session.alert
        waitOnMain("confirm enabled after enableDelay") { confirmEnabled(alert) }
        ui { () -> Void in
            NotificationCenter.default.post(name: UIApplication.didBecomeActiveNotification, object: UIApplication.shared)
        }
        let activeAt = Date()
        waitOnMain("confirm goes dark when the app becomes active", timeout: 1) { !confirmEnabled(alert) }
        waitOnMain("confirm enabled again after the delay") { confirmEnabled(alert) }
        XCTAssertGreaterThanOrEqual(
            Date().timeIntervalSince(activeAt), delay - 0.15,
            "the full delay ran again after becoming active"
        )
        XCTAssertNil(session.box.bool, "becoming active is not an answer")
        presenter.completeForTesting(confirmed: false)
        XCTAssertEqual(answer(session), false, "the alert still answers its own cancel")
        waitOnMain("the alert is dismissed") { isGone(alert) }
    }

    func testIsBusyWhilePendingAndPresentedAndFreeAfter() {
        guard let presenter = makePresenter(enableDelay: 0.2) else {
            return
        }
        XCTAssertFalse(presenter.isBusy, "an idle presenter is not busy")
        let done = expectation(description: "confirm answered")
        let box = startConfirm(presenter, payload(title: "T3 isBusy"), done: done)
        // Main does not run its run loop here, so the presentation the
        // request queued on main cannot run yet: the request is pending.
        let deadline = Date(timeIntervalSinceNow: 5)
        while !presenter.isBusy && Date() < deadline {
            Thread.sleep(forTimeInterval: 0.005)
        }
        XCTAssertTrue(presenter.isBusy, "busy while the request is pending")
        XCTAssertNil(presenter.presentedAlertForTesting, "nothing is presented yet")

        var shown: UIAlertController?
        waitOnMain("the consent alert is presented") {
            shown = presenter.presentedAlertForTesting
            return shown != nil
        }
        XCTAssertTrue(presenter.isBusy, "busy while presented")
        let offMain = LockedList<Bool>()
        let probed = expectation(description: "isBusy read off main")
        Thread {
            offMain.append(presenter.isBusy)
            probed.fulfill()
        }.start()
        wait(for: [probed], timeout: 5)
        XCTAssertEqual(offMain.all, [true], "isBusy reads the same off main")

        presenter.completeForTesting(confirmed: false)
        wait(for: [done], timeout: 10)
        XCTAssertEqual(box.bool, false, "the request answered its cancel")
        XCTAssertFalse(presenter.isBusy, "the slot is free once the request answered")
        if let alert = shown {
            waitOnMain("the alert is dismissed") { isGone(alert) }
        }
    }

    // MARK: m7: a throwing / declining NativeConfirm through the real ABI

    private func wipeScenario(_ confirm: FakeConfirm, file: StaticString, line: UInt) throws -> WipeReport? {
        try isolateWrapItemForM7(self)
        let dir = FileManager.default.temporaryDirectory
            .appendingPathComponent("T3-\(UUID().uuidString)", isDirectory: true)
        do {
            try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        } catch {
            XCTFail("could not create the temp store dir", file: file, line: line)
            return nil
        }
        addTeardownBlock {
            try? FileManager.default.removeItem(at: dir)
        }
        let done = expectation(description: "wipe scenario finished")
        let box = ReportBox()
        runOnDedicatedThread(name: "T3.m7") {
            dispatchPrecondition(condition: .notOnQueue(.main))
            box.set(runWipeScenario(dir: dir, confirm: confirm))
            done.fulfill()
        }
        wait(for: [done], timeout: 30)
        guard let report = box.report else {
            XCTFail("the wipe scenario did not finish", file: file, line: line)
            return nil
        }
        if let setup = report.setupError {
            XCTFail("engine construction / enable failed: \(setup)", file: file, line: line)
            return nil
        }
        XCTAssertEqual(report.provisionedBefore, true, "enable() provisioned the fresh store", file: file, line: line)
        XCTAssertEqual(report.storeFilesBefore, ["store.db", "master.key"], "store files exist before the wipe", file: file, line: line)
        XCTAssertEqual(report.confirmCallsBeforeWipe, 0, "enable() never prompts", file: file, line: line)
        let asked = confirm.payloads
        XCTAssertEqual(asked.count, 1, "one wipe asks exactly once", file: file, line: line)
        XCTAssertEqual(asked.first?.title, "Log out and destroy encrypted data", "core's Wipe copy crossed the ABI", file: file, line: line)
        XCTAssertEqual(asked.first?.kind, "warning", "Wipe is a warning", file: file, line: line)
        XCTAssertEqual(asked.first?.defaultButton, "cancel", "Wipe defaults to cancel", file: file, line: line)
        XCTAssertFalse(confirm.calledOnMain, "the core called confirm off main", file: file, line: line)
        return report
    }

    private func assertWipeDeclined(_ confirm: FakeConfirm, file: StaticString = #filePath, line: UInt = #line) throws {
        guard let report = try wipeScenario(confirm, file: file, line: line) else {
            return
        }
        XCTAssertFalse(report.wipeReturned, "wipe() must throw unless confirm answered true", file: file, line: line)
        var json: NSDictionary?
        if let error = report.wipeError as? E2eeError, case .Failure(let message) = error {
            json = jsonObject(message)
        } else {
            XCTFail("wipe() did not throw an E2eeError", file: file, line: line)
        }
        XCTAssertEqual(json, ["type": "declined"] as NSDictionary, "the wipe error is exactly {type: declined}", file: file, line: line)
        XCTAssertEqual(report.provisionedAfter, true, "a declined wipe leaves the store provisioned", file: file, line: line)
        XCTAssertEqual(report.storeFilesAfter, ["store.db", "master.key"], "a declined wipe deletes nothing", file: file, line: line)
        XCTAssertEqual(
            jsonObject(report.statusAfter)?["enabled"] as? Bool, true,
            "the engine still answers after the decline (process alive, store intact)", file: file, line: line
        )
    }

    func testM7WipeDeclinedWhenConfirmThrowsConfirmErrorFailed() throws {
        try assertWipeDeclined(FakeConfirm(.throwConfirmFailed))
    }

    func testM7WipeDeclinedWhenConfirmThrowsArbitrarySwiftError() throws {
        // An undeclared error crosses as UnexpectedUniFFICallbackError and
        // must map to ConfirmError::Failed (a decline), not a panic/abort.
        try assertWipeDeclined(FakeConfirm(.throwArbitrary))
    }

    func testM7WipeDeclinedWhenConfirmReturnsFalse() throws {
        try assertWipeDeclined(FakeConfirm(.returnFalse))
    }

    func testM7WipeProceedsWhenConfirmReturnsTrue() throws {
        guard let report = try wipeScenario(FakeConfirm(.returnTrue), file: #filePath, line: #line) else {
            return
        }
        XCTAssertTrue(report.wipeReturned, "wipe() succeeds when confirm answers true")
        XCTAssertNil(report.wipeError, "an accepted wipe throws nothing")
        XCTAssertEqual(report.provisionedAfter, false, "an accepted wipe leaves nothing provisioned")
        XCTAssertEqual(report.storeFilesAfter, [], "an accepted wipe deletes the store files")
    }
}
