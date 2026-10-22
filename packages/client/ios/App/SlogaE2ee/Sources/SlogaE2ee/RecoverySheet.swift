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
        let flow = try registry.claim()
        defer { registry.release(flow) }
        let engine = try E2eeRuntime.shared.engine()
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
        let flow = try registry.claim()
        defer { registry.release(flow) }
        let engine = try E2eeRuntime.shared.engine()
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
        guard let flow = registry.active() else {
            return
        }
        DispatchQueue.main.async {
            flow.closeFromMain()
        }
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
                    let secret = SecretBox(record.code)
                    let truncated = record.truncated
                    DispatchQueue.main.async {
                        flow.showCode(secret, truncated: truncated)
                    }
                } catch {
                    // W2 carry-in: after a failed mint nothing is ever
                    // couriered. Core's pending_upload may still hold an
                    // older flow's bundle, and that is not this code's.
                    mintError = error
                    DispatchQueue.main.async {
                        flow.showMintFailed()
                    }
                }
            case .finish where minted && mintError == nil && flow.codeWasShown:
                let outcome = try finishFlow(engine)
                return try courierUpload(engine, outcome: outcome, mode: mode)
            case .restore:
                continue
            case .finish, .close:
                let outcome = try closeFlow(engine, generation: generation)
                if let mintError {
                    throw mintError
                }
                // F3: a code the user has seen must not be left without a
                // server backup, so a close after display still couriers.
                // A code minted but never displayed (teardown during the
                // mint) is not couriered: nobody holds it, and with no
                // server backup the frontend asks again.
                if minted, flow.codeWasShown, let outcome {
                    return try courierUpload(engine, outcome: outcome, mode: mode)
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
    private static func courierUpload(_ engine: E2eeEngine, outcome: String, mode: String) throws -> String {
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
        return bundle
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
    private let lock = NSLock()
    private var current: RecoveryFlow?

    func claim() throws -> RecoveryFlow {
        lock.lock()
        defer { lock.unlock() }
        if current != nil {
            throw busyReject
        }
        let flow = RecoveryFlow()
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
    }

    private let condition = NSCondition()
    private var events: [Event] = []
    private var shown = false

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

    @MainActor func presentSheet(kind: RecoverySheetController.Kind) {
        guard !closedOnMain else {
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
            "If the app closes before you tap \u{201C}I saved it\u{201D}, this code will not work. Create a new one."
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
