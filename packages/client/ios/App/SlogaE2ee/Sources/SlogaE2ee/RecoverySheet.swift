// RecoverySheet.swift: the native key-backup recovery sheets (IE plan D5
// "Recovery sheets"): create, rotate and restore.
//
// The recovery CODE exists only here and in the Rust core. The webview gets
// the ciphertext bundle (create/rotate) or the public-key republish payload
// (restore) and never sees the code, in either direction. This is the only
// file that may call the recovery_* and backup_take_pending_* engine methods
// (gate G8b).
//
// Threads. The caller's dedicated thread (the "flow thread") makes every
// engine call and blocks in an event loop until the flow ends. The sheet
// lives on the main thread and only posts events to that loop. So a close
// can never overtake a running mint or restore: both are a multi-second
// Argon2id that cannot be aborted, and the close is handled after it returns.
//
// Core semantics followed (e2ee-core shell.rs):
//   - recovery_open returns Create (flow opened, generation bumped) or
//     Refocus (a flow is already live). It overwrites the live flow's
//     context in both cases, so a second sheet is refused here, before
//     recovery_open is called, with `busy`.
//   - Refocus while this file has no sheet open means core missed a close:
//     self-heal with a forced recovery_closed(nil), then open again.
//   - recovery_closed / recovery_finish return the core-derived outcome;
//     a minted and displayed code is still couriered on close (F3).
//   - The mint writes nothing (e2ee-recovery-mint-promotion D1/D4): the
//     sealed key and its bundle wait in core's backup slot and become the
//     active backup only when backup_take_pending_upload takes them after
//     the flow has ended. A code minted but never shown must never be
//     taken, so that branch drops the slot with recovery_discard_pending
//     before the flow ends; the previously active key (rotate) stays.
//
// Two teardowns. `teardown()` (called only by E2eePlugin's wipe) closes the
// sheet in any stage. `teardownForNavigation()` (every main-frame load,
// including a WebContent process the system killed and Capacitor reloaded)
// closes it only before a mint or restore has started: once Argon2 runs or
// the code is on screen, the native sheet outlives the page, so the user
// still sees and saves the code that the take will make active.
//
// Orphaned bundle. A sheet that outlived its page still resolves the old
// plugin call, but that page is gone and nothing would upload the bundle
// (on rotate the server would keep the old code's copy, which the new code
// cannot open). So a bundle couriered after a navigation is also kept
// here, with the user id of the flow that minted it, and the page is told
// through `bundleWaitingHook` (E2eePlugin's `backupBundleWaiting` event,
// which carries nothing). The page's refresh then gets it first from the
// plugin's `e2ee_backup_refresh_if_due` arm (`takeOrphanedBundle(userId:)`)
// and uploads it, but only when that refresh is for the same user: one for
// any other account gets nothing and leaves it in place (a stale page after
// a logout must not destroy it), so it never rides another account's upload.
// A restore needs no such stash: the new page re-derives its republish
// payload on demand (`e2ee_backup_rederive_republish`).
//
// `hasActiveFlow` is true from the one-sheet claim until the sheet has gone;
// the consent alert and the save picker refuse to open over it.
//
// Test hooks (internal, for the app-hosted RecoverySheetTests):
//   - `RecoverySheet.engineForTesting`: engine provider; nil = the
//     process engine (`E2eeRuntime.shared.engine()`).
//   - `RecoverySheet.stageForTesting` (main thread): the open sheet's stage
//     name, one of "intro", "minting", "code", "finishing", "mintFailed",
//     "entry", "restoring", "restoreFailed", "closing"; nil = no sheet.
//   - `RecoverySheet.tapForTesting(_:)` (main thread): taps a button if it
//     is visible and enabled, through the same handler as a real tap.
//     Names: "create", "saved" (I saved it), "restore" (the primary
//     button), "cancel", "close" (the secondary button), "copy".
//   - `RecoverySheet.enterCodeForTesting(_:)` (main thread): sets the
//     restore field's text.
import AcutestE2eeBindings
import Foundation
import UIKit
import UniformTypeIdentifiers

enum RecoverySheet {
    /// backupCreate (rotate == false) / backupRotate (rotate == true). Blocks the calling
    /// (dedicated, never main) thread until the sheet closes. Returns the BackupBundle JSON
    /// (`backup_take_pending_upload`) to resolve as `{json}`. Throws `E2eeReject.declined` when
    /// closed before a code was minted, or the core's error.
    static func runCreateOrRotate(rotate: Bool, userId: String) throws -> String {
        dispatchPrecondition(condition: .notOnQueue(.main))
        let mode = rotate ? "rotate" : "create"
        let flow = try registry.claim(userId: userId)
        defer { registry.release(flow) }
        let engine = try currentEngine()
        let generation = try openFlow(engine, mode: mode, userId: userId, blobsJson: nil)
        let kind: RecoverySheetController.Kind = rotate ? .rotate : .create
        DispatchQueue.main.async {
            flow.presentSheet(kind: kind)
        }
        defer { endOnMain(flow) }
        return try createLoop(engine, flow: flow, mode: mode, generation: generation)
    }

    /// backupRestore. Same threading. Returns the republish JSON
    /// (`backup_take_pending_republish`, may be the string "null").
    static func runRestore(userId: String, blobsJson: String) throws -> String {
        dispatchPrecondition(condition: .notOnQueue(.main))
        let flow = try registry.claim(userId: userId)
        defer { registry.release(flow) }
        let engine = try currentEngine()
        let generation = try openFlow(engine, mode: "restore", userId: userId, blobsJson: blobsJson)
        DispatchQueue.main.async {
            flow.presentSheet(kind: .restore)
        }
        defer { endOnMain(flow) }
        return try restoreLoop(engine, flow: flow, generation: generation)
    }

    /// Dismiss any open recovery sheet; its flow then ends through the normal close path
    /// (`recovery_closed`). Any thread; never blocks waiting on main.
    static func teardown() {
        // Called by wipe: a bundle kept for a later upload belongs to the
        // identity being destroyed, and so does anything the open flow
        // couriers from here on. Marked before the clear, atomically, so
        // the flow's courier cannot keep a bundle after it.
        let flow = registry.active()
        registry.tearDown(flow)
        guard let flow else {
            return
        }
        DispatchQueue.main.async {
            flow.closeFromMain()
        }
    }

    /// The bundle of a create/rotate sheet that finished after its page was
    /// reloaded, only when `userId` is the user that sheet's flow was for;
    /// nil otherwise. Clears it only when it is handed out, so it is handed
    /// out once and a refresh for another account leaves it. Any thread.
    static func takeOrphanedBundle(userId: String) -> String? {
        registry.takeOrphanedBundle(userId: userId)
    }

    /// Called once for each bundle kept for a later page, after it is
    /// kept, on the flow thread; it must not block. E2eePlugin installs it
    /// at load. It is told nothing: the page finds out what is waiting
    /// only by asking for it with its own user id. nil until the plugin
    /// loads (nothing listens then).
    static var bundleWaitingHook: (() -> Void)? {
        get { registry.bundleWaitingHook }
        set { registry.bundleWaitingHook = newValue }
    }

    /// True from the one-sheet claim until the sheet's flow has ended and the
    /// sheet has gone. Any thread.
    static var hasActiveFlow: Bool {
        registry.active() != nil
    }

    /// Main-frame load: close the sheet only if no mint or restore has
    /// started. The stage is read on main, in order with the button taps,
    /// so a tap on Create that came first always wins. Any thread; never
    /// blocks waiting on main.
    static func teardownForNavigation() {
        guard let flow = registry.active() else {
            return
        }
        DispatchQueue.main.async {
            flow.navigationCloseFromMain()
        }
    }

    // MARK: - Test hooks

    /// TEST HOOK: engine provider; nil = `E2eeRuntime.shared.engine()`.
    static var engineForTesting: (() throws -> E2eeEngine)? {
        get { registry.engineProvider }
        set { registry.engineProvider = newValue }
    }

    /// Main thread only. TEST HOOK: the open sheet's stage name, nil when none.
    @MainActor static var stageForTesting: String? {
        registry.active()?.stageForTesting
    }

    /// Main thread only. TEST HOOK: tap a sheet button by name (see the file header).
    @MainActor static func tapForTesting(_ button: String) {
        registry.active()?.tapForTesting(button)
    }

    /// Main thread only. TEST HOOK: set the restore field's text.
    @MainActor static func enterCodeForTesting(_ code: String) {
        registry.active()?.enterCodeForTesting(code)
    }

    private static func currentEngine() throws -> E2eeEngine {
        dispatchPrecondition(condition: .notOnQueue(.main))
        if let provider = registry.engineProvider {
            return try provider()
        }
        return try E2eeRuntime.shared.engine()
    }

    // MARK: - Flow loops (flow thread)

    private static let registry = FlowRegistry()

    private static func createLoop(
        _ engine: E2eeEngine,
        flow: RecoveryFlow,
        mode: String,
        generation: UInt64
    ) throws -> String {
        dispatchPrecondition(condition: .notOnQueue(.main))
        var minted = false
        var mintError: Error?
        while true {
            let event = flow.next()
            switch event {
            case .mint:
                guard !minted, mintError == nil else {
                    continue
                }
                do {
                    let record = try mintCode(engine, rotate: mode == "rotate")
                    minted = true
                    // A bundle an earlier sheet left for the next page is
                    // superseded by this mint (newer generation, new key).
                    registry.clearOrphanedBundle()
                    let secret = SecretBox(record.code)
                    let truncated = record.truncated
                    DispatchQueue.main.async {
                        flow.showCode(secret, truncated: truncated)
                    }
                } catch {
                    // W2 carry-in: after a failed mint nothing is ever
                    // couriered. Core's backup slot may still hold an
                    // earlier mint of this flow, and that is not this code's.
                    mintError = error
                    DispatchQueue.main.async {
                        flow.showMintFailed()
                    }
                }
            case .finish where minted && mintError == nil && flow.codeWasShown:
                let outcome = try finishFlow(engine)
                return try courierUpload(engine, flow: flow, outcome: outcome, mode: mode)
            case .restore:
                continue
            case .refused:
                _ = try closeFlow(engine, generation: generation)
                throw busyReject
            case .finish, .close:
                // F3: a code the user has seen must not be left without a
                // server backup, so a close after display still couriers.
                let couriers = minted && mintError == nil && flow.codeWasShown
                // Every other close drops whatever core holds for this flow
                // while the flow is still live, before closeFlow ends it, so
                // no take can promote it after that: a code minted but never
                // displayed (full teardown during the mint, or the sheet
                // dismissed by someone else first) is a key nobody holds, and
                // a take would make it the active backup (on rotate,
                // replacing the key the user's saved code opens). Also after
                // a failed mint, which core may have stored before Swift saw
                // the error. Idempotent, never touches the store.
                if !couriers {
                    discardMintedState(engine)
                }
                let outcome = try closeFlow(engine, generation: generation)
                if let mintError {
                    throw mintError
                }
                if couriers, let outcome {
                    return try courierUpload(engine, flow: flow, outcome: outcome, mode: mode)
                }
                throw E2eeReject.declined
            }
        }
    }

    private static func restoreLoop(
        _ engine: E2eeEngine,
        flow: RecoveryFlow,
        generation: UInt64
    ) throws -> String {
        dispatchPrecondition(condition: .notOnQueue(.main))
        var endError: Error?
        while true {
            let event = flow.next()
            switch event {
            case .restore(let code) where endError == nil:
                do {
                    _ = try restoreWithCode(engine, code: code)
                } catch {
                    let failure = restoreFailure(for: error)
                    if failure == .fatal {
                        endError = error
                    }
                    DispatchQueue.main.async {
                        flow.showRestoreFailed(failure)
                    }
                    continue
                }
                // The store is rebuilt: the flow is consequential whatever
                // the sheet does now, so finish and hand back the republish
                // payload even if a close is already queued.
                _ = try finishFlow(engine)
                return try takeRepublish(engine)
            case .restore:
                continue
            case .mint:
                continue
            case .refused:
                _ = try closeFlow(engine, generation: generation)
                throw busyReject
            case .finish, .close:
                _ = try closeFlow(engine, generation: generation)
                if let endError {
                    throw endError
                }
                throw E2eeReject.declined
            }
        }
    }

    /// Dismiss the sheet (if it is up) and wait for the dismissal to finish,
    /// so the next flow never tries to present over a sheet still animating
    /// away. Bounded: a dismissal that never completes cannot wedge the
    /// one-sheet claim.
    private static func endOnMain(_ flow: RecoveryFlow) {
        let done = DispatchSemaphore(value: 0)
        DispatchQueue.main.async {
            flow.endFromMain {
                done.signal()
            }
        }
        _ = done.wait(timeout: .now() + 10)
    }

    // MARK: - Engine calls (flow thread)

    private struct OpenReply: Decodable {
        let verdict: String
        let generation: UInt64
    }

    private static func openFlow(
        _ engine: E2eeEngine,
        mode: String,
        userId: String,
        blobsJson: String?
    ) throws -> UInt64 {
        dispatchPrecondition(condition: .notOnQueue(.main))
        var reply = try parseOpen(
            E2eeRuntime.shared.withBackgroundTask("gg.sloga.e2ee.recovery") {
                dispatchPrecondition(condition: .notOnQueue(.main))
                return try engine.recoveryOpen(mode: mode, userId: userId, blobsJson: blobsJson)
            })
        if reply.verdict == "refocus" {
            // This file holds the one-sheet claim and has no sheet open, so
            // core's live flag is left over from a close it never got.
            // Forced reset (safe here: only the claim holder opens flows),
            // then open again and honor the Create. The stale flow's outcome
            // is not couriered: it belongs to no sheet of this process.
            reply = try parseOpen(
                E2eeRuntime.shared.withBackgroundTask("gg.sloga.e2ee.recovery") {
                    dispatchPrecondition(condition: .notOnQueue(.main))
                    _ = try engine.recoveryClosed(generation: nil)
                    return try engine.recoveryOpen(mode: mode, userId: userId, blobsJson: blobsJson)
                })
        }
        guard reply.verdict == "create" else {
            throw busyReject
        }
        return reply.generation
    }

    private static func parseOpen(_ json: String) throws -> OpenReply {
        guard let reply = try? JSONDecoder().decode(OpenReply.self, from: Data(json.utf8)) else {
            throw E2eeReject.cryptoFailure
        }
        return reply
    }

    /// Argon2id (seconds, tens of MiB): on the flow thread, never main.
    private static func mintCode(_ engine: E2eeEngine, rotate: Bool) throws -> RecoveryCodeRecord {
        dispatchPrecondition(condition: .notOnQueue(.main))
        return try E2eeRuntime.shared.withBackgroundTask("gg.sloga.e2ee.recovery") {
            dispatchPrecondition(condition: .notOnQueue(.main))
            if rotate {
                return try engine.recoveryRotate()
            }
            return try engine.recoveryCreate()
        }
    }

    /// Argon2id per blob: on the flow thread, never main.
    private static func restoreWithCode(_ engine: E2eeEngine, code: String) throws -> String {
        dispatchPrecondition(condition: .notOnQueue(.main))
        return try E2eeRuntime.shared.withBackgroundTask("gg.sloga.e2ee.recovery") {
            dispatchPrecondition(condition: .notOnQueue(.main))
            return try engine.recoveryRestore(code: code)
        }
    }

    private static func finishFlow(_ engine: E2eeEngine) throws -> String {
        dispatchPrecondition(condition: .notOnQueue(.main))
        return try E2eeRuntime.shared.withBackgroundTask("gg.sloga.e2ee.recovery") {
            dispatchPrecondition(condition: .notOnQueue(.main))
            return try engine.recoveryFinish()
        }
    }

    /// Carries this sheet's generation, so a late report can never end a
    /// newer flow (core ignores a stale one).
    private static func closeFlow(_ engine: E2eeEngine, generation: UInt64) throws -> String? {
        dispatchPrecondition(condition: .notOnQueue(.main))
        return try E2eeRuntime.shared.withBackgroundTask("gg.sloga.e2ee.recovery") {
            dispatchPrecondition(condition: .notOnQueue(.main))
            return try engine.recoveryClosed(generation: generation)
        }
    }

    /// Hand the bundle to the webview courier only when core agrees this
    /// flow minted it (outcome == mode). Any other outcome, or nothing left
    /// to take (a wipe reset the handoff), is a decline, never a "null"
    /// bundle the courier would try to upload.
    private static func courierUpload(
        _ engine: E2eeEngine,
        flow: RecoveryFlow,
        outcome: String,
        mode: String
    ) throws -> String {
        dispatchPrecondition(condition: .notOnQueue(.main))
        guard outcome == mode else {
            throw E2eeReject.declined
        }
        let bundle = try E2eeRuntime.shared.withBackgroundTask("gg.sloga.e2ee.recovery") {
            dispatchPrecondition(condition: .notOnQueue(.main))
            return try engine.backupTakePendingUpload()
        }
        guard bundle != "null" else {
            throw E2eeReject.declined
        }
        // The page that asked was reloaded while the sheet stayed up: the
        // old call's resolve reaches nobody, so keep the bundle for this
        // flow's user and tell the new page, whose refresh for that user
        // uploads it. Never after a wipe's teardown: the bundle then
        // belongs to the destroyed identity. Told after it is kept, so a
        // refresh the event starts always finds it.
        if flow.outlivedItsPage {
            let tell = registry.keepOrphanedBundle(bundle, from: flow)
            tell?()
        }
        return bundle
    }

    /// Best effort: drop the never-shown mint from core's backup slot. Never
    /// promotes and never opens or touches the store (safe after a wipe), so
    /// the previously active key and its code stay exactly as they were.
    /// Idempotent. Never a take: a take after the flow ended would promote.
    private static func discardMintedState(_ engine: E2eeEngine) {
        dispatchPrecondition(condition: .notOnQueue(.main))
        E2eeRuntime.shared.withBackgroundTask("gg.sloga.e2ee.recovery") {
            dispatchPrecondition(condition: .notOnQueue(.main))
            try? engine.recoveryDiscardPending()
        }
    }

    private static func takeRepublish(_ engine: E2eeEngine) throws -> String {
        dispatchPrecondition(condition: .notOnQueue(.main))
        return try E2eeRuntime.shared.withBackgroundTask("gg.sloga.e2ee.recovery") {
            dispatchPrecondition(condition: .notOnQueue(.main))
            return try engine.backupTakePendingRepublish()
        }
    }

    /// A wrong code is the one expected failure and keeps the sheet open. A
    /// rejected blob is also retryable: core reports it instead of a
    /// mismatch when one blob is malformed and the code fit none of the
    /// others, so it can still be a typo. Anything else ends the flow with
    /// the core error.
    private static func restoreFailure(for error: Error) -> RestoreFailure {
        struct Typed: Decodable {
            let type: String
        }
        let json = rejectJson(for: error)
        let type = (try? JSONDecoder().decode(Typed.self, from: Data(json.utf8)))?.type
        switch type {
        case "backup_code_mismatch":
            return .mismatch
        case "backup_blob_rejected":
            return .retry
        default:
            return .fatal
        }
    }
}

/// A second sheet while one is open. Core cannot answer this itself: its
/// recovery_open says Refocus and overwrites the live flow's context, which
/// would re-target the open sheet (a create turned into a restore).
private let busyReject = E2eeReject(json: "{\"type\":\"busy\"}")

private enum RestoreFailure: Equatable {
    case mismatch
    case retry
    case fatal
}

// MARK: - One sheet at a time

/// The one-sheet claim. Held from before recovery_open until the sheet has
/// finished dismissing.
private final class FlowRegistry: @unchecked Sendable {
    /// A kept bundle and the user whose flow minted it.
    private struct Orphan {
        let bundle: String
        let userId: String
    }

    private let lock = NSLock()
    private var current: RecoveryFlow?
    private var provider: (() throws -> E2eeEngine)?
    private var orphan: Orphan?
    private var waitingHook: (() -> Void)?

    /// Keeps `bundle` for `userId` and returns the hook to tell the page
    /// with, read under the same lock. The caller runs it after the lock
    /// is released, so the hook can never deadlock against the registry.
    /// Nil, and nothing kept, once a wipe has torn `flow` down: checked under
    /// the same lock `tearDown(_:)` marks it in, so a keep can never land
    /// after the wipe's clear.
    func keepOrphanedBundle(_ bundle: String, from flow: RecoveryFlow) -> (() -> Void)? {
        lock.lock()
        defer { lock.unlock() }
        guard flow.outlivedItsPage else {
            return nil
        }
        orphan = Orphan(bundle: bundle, userId: flow.userId)
        return waitingHook
    }

    func takeOrphanedBundle(userId: String) -> String? {
        lock.lock()
        defer { lock.unlock() }
        // Byte for byte: Swift's String == treats canonically equivalent
        // Unicode as equal, and the bundle must go only to the exact id it
        // was minted under. Compared before it is cleared: a refresh for
        // anyone else (a stale page after a logout) leaves it in place.
        guard let kept = orphan, kept.userId.utf8.elementsEqual(userId.utf8) else {
            return nil
        }
        orphan = nil
        return kept.bundle
    }

    func clearOrphanedBundle() {
        lock.lock()
        orphan = nil
        lock.unlock()
    }

    /// Wipe: marks the open flow torn down and drops any kept bundle in one
    /// critical section (lock order registry, then the flow's condition).
    func tearDown(_ flow: RecoveryFlow?) {
        lock.lock()
        flow?.markFullTeardown()
        orphan = nil
        lock.unlock()
    }

    var bundleWaitingHook: (() -> Void)? {
        get {
            lock.lock()
            defer { lock.unlock() }
            return waitingHook
        }
        set {
            lock.lock()
            waitingHook = newValue
            lock.unlock()
        }
    }

    var engineProvider: (() throws -> E2eeEngine)? {
        get {
            lock.lock()
            defer { lock.unlock() }
            return provider
        }
        set {
            lock.lock()
            provider = newValue
            lock.unlock()
        }
    }

    func claim(userId: String) throws -> RecoveryFlow {
        lock.lock()
        defer { lock.unlock() }
        if current != nil {
            throw busyReject
        }
        let flow = RecoveryFlow(userId: userId)
        current = flow
        return flow
    }

    func release(_ flow: RecoveryFlow) {
        lock.lock()
        if current === flow {
            current = nil
        }
        lock.unlock()
    }

    func active() -> RecoveryFlow? {
        lock.lock()
        defer { lock.unlock() }
        return current
    }
}

/// The minted code, owned here so it can be zeroed when the sheet closes
/// (best effort: the label's and pasteboard's copies belong to UIKit, and
/// the String the binding returned is not ours to wipe). Main thread only
/// after creation.
private final class SecretBox: @unchecked Sendable {
    private var bytes: Data

    init(_ code: String) {
        bytes = Data(code.utf8)
    }

    var string: String {
        String(decoding: bytes, as: UTF8.self)
    }

    func wipe() {
        zeroize(&bytes)
        bytes = Data()
    }
}

// MARK: - Flow state shared by the two threads

/// One sheet's lifetime. The event queue is the only channel from the sheet
/// to the flow thread. `closedOnMain` and `controller` are main-thread only;
/// they make "closed" and "code shown" one ordered decision on main, so the
/// flow thread can trust `codeWasShown` when it handles a close.
private final class RecoveryFlow: @unchecked Sendable {
    enum Event {
        case mint
        case finish
        case close
        case restore(String)
        /// The sheet was never shown because a consent alert is up.
        case refused
    }

    /// The user the plugin call opened this flow for (recovery_open's
    /// user id). A bundle this flow keeps for a later page goes only to a
    /// refresh for this user.
    let userId: String

    private let condition = NSCondition()
    private var events: [Event] = []
    private var shown = false

    init(userId: String) {
        self.userId = userId
    }

    // Main thread only.
    private var closedOnMain = false
    private var controller: RecoverySheetController?

    func post(_ event: Event) {
        condition.lock()
        events.append(event)
        condition.signal()
        condition.unlock()
    }

    /// Flow thread: blocks until the sheet posts something.
    func next() -> Event {
        condition.lock()
        defer { condition.unlock() }
        while events.isEmpty {
            condition.wait()
        }
        return events.removeFirst()
    }

    var codeWasShown: Bool {
        condition.lock()
        defer { condition.unlock() }
        return shown
    }

    // Guarded by `condition`, like `shown`.
    private var navigatedAway = false
    private var fullTeardown = false

    func markFullTeardown() {
        condition.lock()
        fullTeardown = true
        condition.unlock()
    }

    /// A main-frame load found this sheet past the point of closing, and no
    /// wipe has torn it down since.
    var outlivedItsPage: Bool {
        condition.lock()
        defer { condition.unlock() }
        return navigatedAway && !fullTeardown
    }

    @MainActor func presentSheet(kind: RecoverySheetController.Kind) {
        guard !closedOnMain else {
            return
        }
        // Never stack over a consent alert (ours or another lane's): the
        // sheet would hide the alert's buttons, or the alert the sheet's.
        // The caller gets `busy` after the flow is closed in core.
        if NativeConfirmPresenter.shared.isBusy
            || NativeConfirmPresenter.topMostViewController() is UIAlertController {
            closedOnMain = true
            post(.refused)
            return
        }
        let sheet = RecoverySheetController(kind: kind, flow: self)
        controller = sheet
        guard let top = NativeConfirmPresenter.topMostViewController(),
              top.viewIfLoaded?.window != nil,
              top.presentedViewController == nil,
              !top.isBeingDismissed,
              sheet.present(from: top)
        else {
            // Nothing to show it on: end the flow (a decline), never wait
            // for a button nobody can see.
            closeFromMain()
            return
        }
    }

    /// Cancel, Close, teardown, or the sheet dismissed by someone else.
    @MainActor func closeFromMain() {
        guard !closedOnMain else {
            return
        }
        closedOnMain = true
        controller?.dismissSheet {}
        post(.close)
    }

    /// A main-frame load: close only while nothing has started (a sheet not
    /// yet presented counts as not started).
    @MainActor func navigationCloseFromMain() {
        guard !closedOnMain else {
            return
        }
        if let controller, !controller.closableOnNavigation {
            // The sheet stays; whatever it couriers later has no page to
            // receive it through the old call.
            condition.lock()
            navigatedAway = true
            condition.unlock()
            return
        }
        closeFromMain()
    }

    @MainActor var stageForTesting: String? {
        controller?.stageName
    }

    @MainActor func tapForTesting(_ button: String) {
        controller?.tapForTesting(button)
    }

    @MainActor func enterCodeForTesting(_ code: String) {
        controller?.enterCodeForTesting(code)
    }

    @MainActor func finishFromMain() {
        guard !closedOnMain else {
            return
        }
        closedOnMain = true
        post(.finish)
    }

    @MainActor func mintFromMain() {
        guard !closedOnMain else {
            return
        }
        post(.mint)
    }

    @MainActor func submitFromMain(_ code: String) {
        guard !closedOnMain else {
            return
        }
        post(.restore(code))
    }

    @MainActor func showCode(_ secret: SecretBox, truncated: Bool) {
        guard !closedOnMain, let controller, controller.showCode(secret, truncated: truncated) else {
            secret.wipe()
            return
        }
        condition.lock()
        shown = true
        condition.unlock()
    }

    @MainActor func showMintFailed() {
        guard !closedOnMain else {
            return
        }
        controller?.showMintFailed()
    }

    @MainActor func showRestoreFailed(_ failure: RestoreFailure) {
        guard !closedOnMain else {
            return
        }
        controller?.showRestoreFailed(failure)
    }

    @MainActor func endFromMain(_ done: @escaping () -> Void) {
        closedOnMain = true
        guard let sheet = controller else {
            done()
            return
        }
        controller = nil
        sheet.wipeSecrets()
        sheet.dismissSheet(done)
    }
}

// MARK: - The sheet (main thread)

private final class RecoverySheetController: UIViewController, UITextFieldDelegate {
    enum Kind {
        case create
        case rotate
        case restore
    }

    private enum Stage {
        case intro
        case minting
        case code
        case finishing
        case mintFailed
        case entry
        case restoring
        case restoreFailed
        case closing
    }

    private enum Presentation {
        case idle
        case presenting
        case presented
        case dismissing
        case dismissed
    }

    private static let maxCodeInput = 256

    private let kind: Kind
    private let flow: RecoveryFlow
    private var stage: Stage
    private var presentation = Presentation.idle
    private var dismissAfterPresent = false
    private var dismissWaiters: [() -> Void] = []
    private var secret: SecretBox?
    private var truncated = false
    private var resignedActive = false
    private var revealing = false
    private var statusText: String?
    private var statusIsError = false

    private let scroll = UIScrollView()
    private let stack = UIStackView()
    private let titleLabel = UILabel()
    private let bodyLabel = UILabel()
    private let codeBox = UIView()
    private let codeLabel = UILabel()
    private let truncatedLabel = UILabel()
    private let warningLabel = UILabel()
    private let fieldRow = UIStackView()
    private let field = UITextField()
    private let revealButton = UIButton(type: .system)
    private let revealLabel = UILabel()
    private let statusLabel = UILabel()
    private let spinner = UIActivityIndicatorView(style: .medium)
    private let screenshotLabel = UILabel()
    private let copyButton = UIButton(configuration: .gray())
    private let primaryButton = UIButton(configuration: .filled())
    private let secondaryButton = UIButton(configuration: .plain())
    private let cover = UIView()
    private let coverLabel = UILabel()

    init(kind: Kind, flow: RecoveryFlow) {
        self.kind = kind
        self.flow = flow
        self.stage = kind == .restore ? .entry : .intro
        super.init(nibName: nil, bundle: nil)
        modalPresentationStyle = .pageSheet
        // Not swipe-dismissable: the only ways out are the sheet's own
        // buttons and teardown, each of which ends the flow in core.
        isModalInPresentation = true
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        nil
    }

    // MARK: Presentation lifecycle

    /// False when UIKit refused the presentation.
    func present(from top: UIViewController) -> Bool {
        presentation = .presenting
        top.present(self, animated: true) {
            self.didPresent()
        }
        if presentingViewController == nil && top.presentedViewController !== self {
            presentation = .dismissed
            return false
        }
        return true
    }

    private func didPresent() {
        guard presentation == .presenting else {
            return
        }
        presentation = .presented
        if dismissAfterPresent {
            performDismiss()
        }
    }

    func dismissSheet(_ completion: @escaping () -> Void) {
        switch presentation {
        case .idle, .dismissed:
            completion()
        case .dismissing:
            dismissWaiters.append(completion)
        case .presenting:
            dismissWaiters.append(completion)
            dismissAfterPresent = true
        case .presented:
            dismissWaiters.append(completion)
            performDismiss()
        }
    }

    private func performDismiss() {
        presentation = .dismissing
        stage = .closing
        if isViewLoaded {
            render()
        }
        // Dismiss through the presenter: calling dismiss on self while an
        // alert sits on top of the sheet would dismiss only the alert.
        guard let presenter = presentingViewController else {
            finishDismiss()
            return
        }
        presenter.dismiss(animated: true) {
            self.finishDismiss()
        }
    }

    private func finishDismiss() {
        presentation = .dismissed
        let waiters = dismissWaiters
        dismissWaiters = []
        for waiter in waiters {
            waiter()
        }
    }

    override func viewDidDisappear(_ animated: Bool) {
        super.viewDidDisappear(animated)
        // Dismissed by someone else (for example the whole presented stack
        // torn down): the flow must still end, or its thread waits forever.
        if presentation == .presented, isBeingDismissed || presentingViewController == nil {
            finishDismiss()
            flow.closeFromMain()
        }
    }

    // MARK: Flow-driven updates

    /// False when the sheet is no longer on screen (the code is then never
    /// displayed and counts as not shown).
    func showCode(_ secret: SecretBox, truncated: Bool) -> Bool {
        guard stage == .minting, presentation == .presenting || presentation == .presented else {
            return false
        }
        self.secret = secret
        self.truncated = truncated
        stage = .code
        statusText = nil
        loadViewIfNeeded()
        codeLabel.text = Self.displayLines(secret.string)
        render()
        return true
    }

    func showMintFailed() {
        guard stage == .minting else {
            return
        }
        stage = .mintFailed
        setStatus("Could not create a recovery code.", error: true)
        render()
    }

    func showRestoreFailed(_ failure: RestoreFailure) {
        guard stage == .restoring else {
            return
        }
        switch failure {
        case .mismatch:
            stage = .entry
            setStatus("That code did not match. Check it and try again.", error: true)
        case .retry:
            stage = .entry
            setStatus("Restore failed. Check your code and try again.", error: true)
        case .fatal:
            stage = .restoreFailed
            field.text = nil
            setStatus("Restore failed.", error: true)
        }
        render()
        if stage == .entry {
            field.becomeFirstResponder()
        }
    }

    /// Best effort: drop every copy of the code this sheet holds.
    func wipeSecrets() {
        secret?.wipe()
        secret = nil
        guard isViewLoaded else {
            return
        }
        codeLabel.text = nil
        field.text = nil
        endReveal()
    }

    /// Navigation may close the sheet only while nothing is in flight and no
    /// code is on screen: before Create or Restore, or after either failed
    /// (nothing was minted or restored then, so nothing is lost).
    var closableOnNavigation: Bool {
        switch stage {
        case .intro, .entry, .mintFailed, .restoreFailed:
            return true
        case .minting, .code, .finishing, .restoring, .closing:
            return false
        }
    }

    var stageName: String {
        switch stage {
        case .intro: return "intro"
        case .minting: return "minting"
        case .code: return "code"
        case .finishing: return "finishing"
        case .mintFailed: return "mintFailed"
        case .entry: return "entry"
        case .restoring: return "restoring"
        case .restoreFailed: return "restoreFailed"
        case .closing: return "closing"
        }
    }

    /// TEST HOOK: a tap on the named button, only if a user could make it
    /// now (visible, enabled, showing that label), sent through the
    /// button's own target-action.
    func tapForTesting(_ name: String) {
        let target: (button: UIButton, title: String)
        switch name {
        case "create": target = (primaryButton, "Create code")
        case "saved": target = (primaryButton, "I saved it")
        case "restore": target = (primaryButton, "Restore")
        case "cancel": target = (secondaryButton, "Cancel")
        case "close": target = (secondaryButton, "Close")
        case "copy": target = (copyButton, "Copy")
        default: return
        }
        guard isViewLoaded, !target.button.isHidden, target.button.isEnabled,
              target.button.configuration?.title == target.title
        else {
            return
        }
        target.button.sendActions(for: .touchUpInside)
    }

    /// TEST HOOK: type a code into the restore field.
    func enterCodeForTesting(_ code: String) {
        guard isViewLoaded, stage == .entry else {
            return
        }
        field.text = code
    }

    // MARK: Actions

    @objc private func primaryTapped() {
        switch stage {
        case .intro:
            stage = .minting
            setStatus(nil, error: false)
            render()
            flow.mintFromMain()
        case .code:
            stage = .finishing
            render()
            flow.finishFromMain()
        case .entry:
            submitRestore()
        default:
            break
        }
    }

    @objc private func secondaryTapped() {
        switch stage {
        case .intro, .mintFailed, .entry, .restoreFailed:
            field.resignFirstResponder()
            flow.closeFromMain()
        default:
            break
        }
    }

    @objc private func copyTapped() {
        guard stage == .code, let secret else {
            return
        }
        // Local only (no Universal Clipboard to other devices) and gone
        // after two minutes.
        UIPasteboard.general.setItems(
            [[UTType.utf8PlainText.identifier: secret.string]],
            options: [.localOnly: true, .expirationDate: Date().addingTimeInterval(120)]
        )
        setStatus("Copied. It clears from the clipboard in 2 minutes.", error: false)
        render()
    }

    private func submitRestore() {
        let code = field.text ?? ""
        guard !code.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            setStatus("Enter your recovery code.", error: true)
            render()
            return
        }
        endReveal()
        field.resignFirstResponder()
        stage = .restoring
        setStatus(nil, error: false)
        render()
        flow.submitFromMain(code)
    }

    @objc private func beginReveal() {
        guard stage == .entry, cover.isHidden else {
            return
        }
        revealing = true
        revealLabel.text = field.text
        revealLabel.isHidden = (field.text ?? "").isEmpty
    }

    @objc private func endReveal() {
        revealing = false
        revealLabel.text = nil
        revealLabel.isHidden = true
    }

    // MARK: Capture and snapshot hiding

    @objc private func captureChanged() {
        updateCover()
    }

    @objc private func willResignActive() {
        resignedActive = true
        updateCover()
    }

    @objc private func didBecomeActive() {
        resignedActive = false
        updateCover()
    }

    @objc private func screenshotTaken() {
        // iOS cannot block screenshots; say what to do with one.
        guard secret != nil || revealing else {
            return
        }
        screenshotLabel.isHidden = false
    }

    /// The code is hidden while the screen is recorded, mirrored or shared,
    /// and before the app-switcher snapshot is taken.
    private func updateCover() {
        guard isViewLoaded else {
            return
        }
        let captured = (view.window?.windowScene?.screen ?? UIScreen.main).isCaptured
        let hide = captured || resignedActive
        coverLabel.text = captured ? "Hidden while your screen is recorded or shared." : nil
        cover.isHidden = !hide
        if hide {
            endReveal()
        }
        view.bringSubviewToFront(cover)
    }

    // MARK: Text field

    /// The edit is applied by hand: a secure field otherwise wipes its whole
    /// content on the first keystroke after it regains focus, which loses a
    /// 71-character code to a stray tap.
    func textField(
        _ textField: UITextField,
        shouldChangeCharactersIn range: NSRange,
        replacementString string: String
    ) -> Bool {
        guard stage == .entry else {
            return false
        }
        let current = textField.text ?? ""
        guard let swiftRange = Range(range, in: current) else {
            return false
        }
        let updated = current.replacingCharacters(in: swiftRange, with: string)
        guard updated.utf16.count <= Self.maxCodeInput else {
            return false
        }
        textField.text = updated
        let offset = range.location + string.utf16.count
        if let position = textField.position(from: textField.beginningOfDocument, offset: offset) {
            textField.selectedTextRange = textField.textRange(from: position, to: position)
        }
        if revealing {
            revealLabel.text = updated
            revealLabel.isHidden = updated.isEmpty
        }
        if statusText != nil {
            setStatus(nil, error: false)
            render()
        }
        return false
    }

    func textFieldShouldReturn(_ textField: UITextField) -> Bool {
        if stage == .entry {
            submitRestore()
        }
        return false
    }

    // MARK: View

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .systemBackground
        buildViews()
        let center = NotificationCenter.default
        center.addObserver(self, selector: #selector(captureChanged),
                           name: UIScreen.capturedDidChangeNotification, object: nil)
        center.addObserver(self, selector: #selector(willResignActive),
                           name: UIApplication.willResignActiveNotification, object: nil)
        center.addObserver(self, selector: #selector(didBecomeActive),
                           name: UIApplication.didBecomeActiveNotification, object: nil)
        center.addObserver(self, selector: #selector(screenshotTaken),
                           name: UIApplication.userDidTakeScreenshotNotification, object: nil)
        resignedActive = UIApplication.shared.applicationState != .active
        render()
        updateCover()
    }

    override func viewWillAppear(_ animated: Bool) {
        super.viewWillAppear(animated)
        updateCover()
    }

    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        updateCover()
        if stage == .entry {
            field.becomeFirstResponder()
        }
    }

    private func buildViews() {
        scroll.translatesAutoresizingMaskIntoConstraints = false
        scroll.alwaysBounceVertical = true
        scroll.keyboardDismissMode = .interactive
        view.addSubview(scroll)

        stack.axis = .vertical
        stack.spacing = 14
        stack.alignment = .fill
        stack.translatesAutoresizingMaskIntoConstraints = false
        scroll.addSubview(stack)

        titleLabel.font = .preferredFont(forTextStyle: .title2)
        titleLabel.adjustsFontForContentSizeCategory = true
        titleLabel.numberOfLines = 0

        for label in [bodyLabel, truncatedLabel, warningLabel, statusLabel, screenshotLabel] {
            label.font = .preferredFont(forTextStyle: .body)
            label.adjustsFontForContentSizeCategory = true
            label.numberOfLines = 0
        }
        bodyLabel.textColor = .secondaryLabel
        truncatedLabel.textColor = .secondaryLabel
        truncatedLabel.text = "Your history is large, so only your most recent messages are backed up."
        warningLabel.textColor = .systemOrange
        warningLabel.text =
            "If the app closes before this sheet does, this code will not work and your previous code (if any) stays valid. Create a new one."
        screenshotLabel.textColor = .systemOrange
        screenshotLabel.text = "Screenshot taken. Store it somewhere safe or delete it."
        screenshotLabel.isHidden = true

        // A plain label: not selectable, so no system menu can share or look
        // up the code. Copy is the only export.
        codeLabel.font = UIFontMetrics(forTextStyle: .title3).scaledFont(
            for: .monospacedSystemFont(ofSize: 19, weight: .semibold), maximumPointSize: 26)
        codeLabel.adjustsFontForContentSizeCategory = true
        codeLabel.numberOfLines = 0
        codeLabel.lineBreakMode = .byCharWrapping
        codeLabel.textAlignment = .center
        codeLabel.translatesAutoresizingMaskIntoConstraints = false
        codeBox.backgroundColor = .secondarySystemBackground
        codeBox.layer.cornerRadius = 10
        codeBox.addSubview(codeLabel)
        NSLayoutConstraint.activate([
            codeLabel.topAnchor.constraint(equalTo: codeBox.topAnchor, constant: 16),
            codeLabel.bottomAnchor.constraint(equalTo: codeBox.bottomAnchor, constant: -16),
            codeLabel.leadingAnchor.constraint(equalTo: codeBox.leadingAnchor, constant: 12),
            codeLabel.trailingAnchor.constraint(equalTo: codeBox.trailingAnchor, constant: -12),
        ])

        // The code field. Secure entry forces the system keyboard, so a
        // third-party keyboard with Full Access never sees the code, and
        // keeps it out of the keyboard's learning and autofill. No
        // textContentType, so the system offers no saved password for it.
        field.isSecureTextEntry = true
        field.autocorrectionType = .no
        field.spellCheckingType = .no
        field.autocapitalizationType = .none
        field.smartQuotesType = .no
        field.smartDashesType = .no
        field.smartInsertDeleteType = .no
        if #available(iOS 17.0, *) {
            field.inlinePredictionType = .no
        }
        field.keyboardType = .asciiCapable
        field.returnKeyType = .go
        field.borderStyle = .roundedRect
        field.font = .monospacedSystemFont(ofSize: 17, weight: .regular)
        field.placeholder = "XXXXX-XXXXX-XXXXX-\u{2026}"
        field.delegate = self

        // Press and hold shows the typed code in a separate label. The field
        // itself never leaves secure entry: turning it off would hand the
        // text to whatever keyboard is installed.
        var reveal = UIButton.Configuration.plain()
        reveal.title = "Hold to show"
        revealButton.configuration = reveal
        revealButton.addTarget(self, action: #selector(beginReveal), for: .touchDown)
        revealButton.addTarget(self, action: #selector(endReveal),
                               for: [.touchUpInside, .touchUpOutside, .touchCancel, .touchDragExit])
        revealButton.setContentHuggingPriority(.required, for: .horizontal)
        revealButton.setContentCompressionResistancePriority(.required, for: .horizontal)
        fieldRow.axis = .horizontal
        fieldRow.spacing = 8
        fieldRow.alignment = .center
        fieldRow.addArrangedSubview(field)
        fieldRow.addArrangedSubview(revealButton)

        revealLabel.font = .monospacedSystemFont(ofSize: 17, weight: .regular)
        revealLabel.numberOfLines = 0
        revealLabel.lineBreakMode = .byCharWrapping
        revealLabel.isHidden = true

        copyButton.configuration?.title = "Copy"
        copyButton.addTarget(self, action: #selector(copyTapped), for: .touchUpInside)
        primaryButton.addTarget(self, action: #selector(primaryTapped), for: .touchUpInside)
        secondaryButton.addTarget(self, action: #selector(secondaryTapped), for: .touchUpInside)
        spinner.hidesWhenStopped = true

        for item in [titleLabel, bodyLabel, codeBox, truncatedLabel, warningLabel, fieldRow, revealLabel,
                     statusLabel, spinner, screenshotLabel, copyButton, primaryButton, secondaryButton] {
            stack.addArrangedSubview(item)
        }
        stack.setCustomSpacing(24, after: screenshotLabel)

        cover.backgroundColor = .systemBackground
        cover.translatesAutoresizingMaskIntoConstraints = false
        cover.isHidden = true
        coverLabel.font = .preferredFont(forTextStyle: .body)
        coverLabel.textColor = .secondaryLabel
        coverLabel.numberOfLines = 0
        coverLabel.textAlignment = .center
        coverLabel.translatesAutoresizingMaskIntoConstraints = false
        cover.addSubview(coverLabel)
        view.addSubview(cover)

        let content = scroll.contentLayoutGuide
        let frame = scroll.frameLayoutGuide
        NSLayoutConstraint.activate([
            scroll.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor),
            scroll.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            scroll.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            scroll.bottomAnchor.constraint(equalTo: view.keyboardLayoutGuide.topAnchor),
            stack.topAnchor.constraint(equalTo: content.topAnchor, constant: 28),
            stack.bottomAnchor.constraint(equalTo: content.bottomAnchor, constant: -24),
            stack.leadingAnchor.constraint(equalTo: frame.leadingAnchor, constant: 24),
            stack.trailingAnchor.constraint(equalTo: frame.trailingAnchor, constant: -24),
            cover.topAnchor.constraint(equalTo: view.topAnchor),
            cover.bottomAnchor.constraint(equalTo: view.bottomAnchor),
            cover.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            cover.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            coverLabel.centerYAnchor.constraint(equalTo: cover.centerYAnchor),
            coverLabel.leadingAnchor.constraint(equalTo: cover.leadingAnchor, constant: 32),
            coverLabel.trailingAnchor.constraint(equalTo: cover.trailingAnchor, constant: -32),
        ])
    }

    private func setStatus(_ text: String?, error: Bool) {
        statusText = text
        statusIsError = error
    }

    private func render() {
        guard isViewLoaded else {
            return
        }
        let restore = kind == .restore
        switch stage {
        case .code, .finishing:
            titleLabel.text = "Your recovery code"
            bodyLabel.text =
                "Write it down and keep it somewhere safe. It is the only way to restore your encrypted "
                + "messages on a new device. Anyone with this code and access to your account can read "
                + "your message history. Sloga cannot recover it for you."
        default:
            if restore {
                titleLabel.text = "Restore from recovery code"
                bodyLabel.text =
                    "Enter the recovery code you saved. This restores your encrypted messages on this device."
            } else if kind == .rotate {
                titleLabel.text = "Create a new recovery code"
                bodyLabel.text = "This makes a new recovery code to replace your current one."
            } else {
                titleLabel.text = "Create a recovery code"
                bodyLabel.text =
                    "A recovery code lets you restore your encrypted messages on a new device. "
                    + "Sloga cannot recover it for you."
            }
        }

        let showingCode = stage == .code || stage == .finishing
        codeBox.isHidden = !showingCode
        truncatedLabel.isHidden = !(showingCode && truncated)
        warningLabel.isHidden = !showingCode
        copyButton.isHidden = stage != .code
        if !showingCode && !revealing {
            screenshotLabel.isHidden = true
        }

        let entering = stage == .entry || stage == .restoring
        fieldRow.isHidden = !entering
        field.isEnabled = stage == .entry
        revealButton.isEnabled = stage == .entry
        if !entering {
            endReveal()
        }

        switch stage {
        case .minting:
            setStatus("Creating your code. This can take a few seconds.", error: false)
        case .restoring:
            setStatus("Restoring. This can take a moment.", error: false)
        default:
            break
        }
        statusLabel.text = statusText
        statusLabel.textColor = statusIsError ? .systemRed : .secondaryLabel
        statusLabel.isHidden = statusText == nil

        if stage == .minting || stage == .restoring || stage == .finishing {
            spinner.startAnimating()
        } else {
            spinner.stopAnimating()
        }

        switch stage {
        case .intro:
            configure(primaryButton, title: "Create code", enabled: true)
            configure(secondaryButton, title: "Cancel", enabled: true)
        case .minting:
            // Cancel is off while Argon2 runs: it cannot be aborted, and a
            // cancel queued behind it would leave a minted code nobody saw.
            configure(primaryButton, title: "Create code", enabled: false)
            configure(secondaryButton, title: "Cancel", enabled: false)
        case .code:
            // No Cancel once the code is on screen: the backup is uploaded
            // on any close from here (F3), so "Cancel" would be untrue.
            configure(primaryButton, title: "I saved it", enabled: true)
            configure(secondaryButton, title: nil, enabled: false)
        case .finishing:
            configure(primaryButton, title: "I saved it", enabled: false)
            configure(secondaryButton, title: nil, enabled: false)
        case .mintFailed, .restoreFailed:
            configure(primaryButton, title: nil, enabled: false)
            configure(secondaryButton, title: "Close", enabled: true)
        case .entry:
            configure(primaryButton, title: "Restore", enabled: true)
            configure(secondaryButton, title: "Cancel", enabled: true)
        case .restoring:
            configure(primaryButton, title: "Restore", enabled: false)
            configure(secondaryButton, title: "Cancel", enabled: false)
        case .closing:
            primaryButton.isEnabled = false
            secondaryButton.isEnabled = false
            copyButton.isEnabled = false
            field.isEnabled = false
            revealButton.isEnabled = false
        }
    }

    private func configure(_ button: UIButton, title: String?, enabled: Bool) {
        guard let title else {
            button.isHidden = true
            button.isEnabled = false
            return
        }
        button.configuration?.title = title
        button.isHidden = false
        button.isEnabled = enabled
    }

    /// The core's code is 12 groups of 5 joined by "-". Shown as three lines
    /// of four groups so it never wraps mid-group; restore ignores
    /// separators and line breaks. Anything else falls back to the raw
    /// string, wrapped by character.
    private static func displayLines(_ code: String) -> String {
        let groups = code.split(separator: "-")
        guard groups.count > 1 else {
            return code
        }
        var lines: [String] = []
        var index = 0
        while index < groups.count {
            let end = min(index + 4, groups.count)
            lines.append(groups[index..<end].joined(separator: "-"))
            index = end
        }
        return lines.joined(separator: "\n")
    }
}
