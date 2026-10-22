// NativeConfirm.swift: the blocking native consent dialog the Rust core calls
// through uniffi's foreign trait `NativeConfirm` (IE plan D1 "Blocking-prompt
// safety" and "Teardown", D5 "NativeConfirm").
//
// The core's adapter treats only `Ok(true)` as consent, so every path here
// that is not a deliberate tap on the confirm button answers `false`: bad
// copy, a busy slot, a failed presentation, teardown, timeout, and the
// alert being removed from outside (someone dismissing what it sits on).
//
// Threading: `confirm` runs on the engine-calling thread (never main), hops
// to main with `DispatchQueue.main.async` to present, and waits on a
// condition with a timeout. Nothing here waits on main from main, and
// nothing calls UIKit off main.
import AcutestE2eeBindings
import Foundation
import UIKit

/// Settle-exactly-once box for one dialog's answer.
final class ConsentSettlement: @unchecked Sendable {
    private let condition = NSCondition()
    private var value: Bool?

    init() {}

    /// Records `value` if nothing was recorded yet and wakes the waiter. Returns true when
    /// THIS call settled it.
    @discardableResult func settle(_ value: Bool) -> Bool {
        condition.lock()
        defer { condition.unlock() }
        // First answer wins. A late tap after a timeout or teardown cannot
        // flip a decline the caller may already have acted on.
        guard self.value == nil else {
            return false
        }
        self.value = value
        condition.broadcast()
        return true
    }

    /// Blocks until settled; nil when `timeout` elapsed first (the caller then settles false).
    func wait(timeout: TimeInterval) -> Bool? {
        let deadline = Date(timeIntervalSinceNow: boundedInterval(timeout, fallback: 0))
        condition.lock()
        defer { condition.unlock() }
        while value == nil {
            // `wait(until:)` returns false once the deadline has passed; a
            // spurious wakeup returns true and the loop re-checks.
            if !condition.wait(until: deadline) {
                break
            }
        }
        return value
    }
}

/// A finite, non-negative interval capped at one hour, so no caller-supplied
/// value (NaN, infinity, negative) can turn a bounded wait into a forever wait.
private func boundedInterval(_ interval: TimeInterval, fallback: TimeInterval) -> TimeInterval {
    guard interval.isFinite else {
        return fallback
    }
    return min(max(interval, 0), 3600)
}

/// How long a started presentation may take before it counts as failed. An
/// alert presentation animates in well under a second; a completion that
/// never runs means UIKit refused it.
private let presentationDeadline: TimeInterval = 10

/// Which confirm style the core asked for. Parsed off main from the payload's
/// strings, mapped to UIKit on main.
private enum ConsentTone {
    case warning
    case info
}

/// How long after the alert leaves the screen an unanswered request is
/// declined. A button tap also takes the alert off screen, and UIKit runs the
/// action's handler only when that dismissal completes, after
/// `viewDidDisappear`; the grace lets the tap's own answer land first. Should
/// a handler ever come later than this, the tap counts as a decline.
private let removalGrace: TimeInterval = 0.25

/// How often a covered (or not frontmost) alert is looked at again before its
/// confirm may be enabled.
private let coveredRecheck: TimeInterval = 0.1

/// The alert actually shown. It reports its own appearance changes, so a
/// dismissal from outside (another presenter dismissing what it presented)
/// still answers, and a re-appearance restarts the confirm delay.
private final class ConsentAlertController: UIAlertController {
    weak var session: ConsentSession?

    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        session?.restartEnableGuard()
    }

    override func viewDidDisappear(_ animated: Bool) {
        super.viewDidDisappear(animated)
        // Covered by a full-screen presentation: still ours, not an answer.
        // Removed (being dismissed, or no presenter any more): the caller
        // must not wait out the timeout, which would also keep core's
        // consent latch busy and turn every other prompt into a decline.
        if isBeingDismissed || presentingViewController == nil {
            session?.alertRemoved()
        }
    }

    override func present(
        _ viewControllerToPresent: UIViewController,
        animated flag: Bool,
        completion: (() -> Void)? = nil
    ) {
        // Something is about to cover the alert; a sheet over it gives the
        // alert no appearance callbacks, so the guard starts over now.
        session?.restartEnableGuard()
        super.present(viewControllerToPresent, animated: flag, completion: completion)
    }
}

/// Whether the app is frontmost, as told by the resign/become-active
/// notifications this presenter observes (main thread only). Starts true: a
/// presenter is first used from a live session, and any later trip to the
/// background is reported to it.
private final class ForegroundState: @unchecked Sendable {
    var resigned = false
}

/// One consent request, from the slot being taken to its answer. `settlement`
/// is thread-safe; every other field is touched on the main thread only.
private final class ConsentSession: @unchecked Sendable {
    let settlement = ConsentSettlement()
    let enableDelay: TimeInterval
    private let foreground: ForegroundState

    var alert: ConsentAlertController?
    var confirmAction: UIAlertAction?
    /// The present completion ran: the alert is on screen.
    var presented = false
    /// A settle arrived while the presentation was still animating in; UIKit
    /// ignores a dismiss issued mid-presentation, so the completion does it.
    var dismissWhenPresented = false
    /// Bumped on every restart, so only the newest scheduled check can enable.
    private var guardGeneration = 0
    /// A check found the alert covered or the app not frontmost; once it is
    /// visible again the full delay runs again before confirm is enabled.
    private var hiddenDuringGuard = false

    init(enableDelay: TimeInterval, foreground: ForegroundState) {
        self.enableDelay = enableDelay
        self.foreground = foreground
    }

    var isSettled: Bool {
        settlement.wait(timeout: 0) != nil
    }

    /// The one path a button tap (and the test hook) takes. A confirm that
    /// arrives while the confirm action is still disabled is ignored, as a
    /// tap on a disabled button would be.
    @MainActor func buttonPressed(confirmed: Bool) {
        guard presented, alert != nil else {
            return
        }
        if confirmed && confirmAction?.isEnabled != true {
            return
        }
        settle(confirmed)
    }

    /// Settle (first answer wins) and take the alert down if it is still up.
    @MainActor func settle(_ answer: Bool) {
        settlement.settle(answer)
        dismissIfNeeded()
    }

    /// Idempotent: safe to run from every exit path.
    @MainActor func dismissIfNeeded() {
        guard let alert = alert else {
            return
        }
        guard presented else {
            dismissWhenPresented = true
            return
        }
        // A button tap has already dismissed the alert (or is doing so) by
        // the time its handler runs; only a programmatic exit leaves it up.
        // Not animated, so the hierarchy is clean before the next request's
        // presentation (queued behind this on main) looks at it.
        if alert.presentingViewController != nil && !alert.isBeingDismissed {
            alert.dismiss(animated: false)
        }
        self.alert = nil
        confirmAction = nil
    }

    /// The alert left the screen without our dismissal. Decline it unless a
    /// button handler answers within the grace.
    @MainActor func alertRemoved() {
        guard !isSettled else {
            return
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + removalGrace) { [self] in
            MainActor.assumeIsolated {
                if !isSettled {
                    settle(false)
                }
            }
        }
    }

    /// Disable confirm and start the anti-tap-jacking delay over: on first
    /// appearance, on every re-appearance, when something is presented over
    /// the alert, and when the app becomes active again. The user must have
    /// had the alert in view for the whole delay before confirm works.
    @MainActor func restartEnableGuard() {
        guard !isSettled, let action = confirmAction else {
            return
        }
        guardGeneration &+= 1
        hiddenDuringGuard = false
        action.isEnabled = false
        scheduleEnableCheck(guardGeneration, after: enableDelay)
    }

    @MainActor private func scheduleEnableCheck(_ generation: Int, after delay: TimeInterval) {
        DispatchQueue.main.asyncAfter(deadline: .now() + delay) { [self] in
            MainActor.assumeIsolated {
                enableCheck(generation)
            }
        }
    }

    /// Lift the delay, unless the dialog already ended, a newer restart owns
    /// it, or the alert is not actually in view right now.
    @MainActor private func enableCheck(_ generation: Int) {
        guard generation == guardGeneration, !isSettled, let alert = alert, let action = confirmAction else {
            return
        }
        if !isInView(alert) {
            hiddenDuringGuard = true
            scheduleEnableCheck(generation, after: coveredRecheck)
            return
        }
        if hiddenDuringGuard {
            restartEnableGuard()
            return
        }
        action.isEnabled = true
    }

    /// On screen and frontmost, judged only from what this code observes: the
    /// alert's view is in a window (a full-screen cover takes it out), nothing
    /// is presented over it (a sheet), it is not leaving, and the app has not
    /// resigned active since it last became active.
    @MainActor private func isInView(_ alert: UIAlertController) -> Bool {
        alert.viewIfLoaded?.window != nil
            && alert.presentedViewController == nil
            && !alert.isBeingDismissed
            && !foreground.resigned
    }

    /// The app is leaving the foreground: confirm goes dark at once, so the
    /// first touch after returning cannot land on it.
    @MainActor func disableUntilActive() {
        guard !isSettled, let action = confirmAction else {
            return
        }
        action.isEnabled = false
        hiddenDuringGuard = true
    }
}

final class NativeConfirmPresenter: NativeConfirm, @unchecked Sendable {
    static let shared = NativeConfirmPresenter()

    private let presenter: () -> UIViewController?
    private let enableDelay: TimeInterval
    private let timeout: TimeInterval

    /// The single consent slot. Taken atomically before anything is
    /// presented, so two prompts can never stack (wipe, downgrade and peer
    /// downgrade have no core-side latch, D1).
    private let lock = NSLock()
    private var current: ConsentSession?

    private var observers: [NSObjectProtocol] = []
    private let foreground = ForegroundState()

    /// `presenter` is called on the main thread; nil means presentation failure (answer false).
    init(
        presenter: @escaping () -> UIViewController? = NativeConfirmPresenter.topMostViewController,
        enableDelay: TimeInterval = 0.7,
        timeout: TimeInterval = 600
    ) {
        self.presenter = presenter
        self.enableDelay = boundedInterval(enableDelay, fallback: 0.7)
        self.timeout = boundedInterval(timeout, fallback: 600)
        // No scene delegate, so app exit is the only teardown UIKit reports
        // to us; a dialog must not outlive the process's caller (D1).
        let center = NotificationCenter.default
        observers.append(center.addObserver(
            forName: UIApplication.willTerminateNotification,
            object: nil,
            queue: nil
        ) { [weak self] _ in
            self?.declineAll()
        })
        // Backgrounding, the app switcher or a system overlay hides the alert
        // without any appearance callback; the confirm delay must not run
        // out unseen, so it goes dark on resign and starts over on return.
        observers.append(center.addObserver(
            forName: UIApplication.willResignActiveNotification,
            object: nil,
            queue: .main
        ) { [weak self] _ in
            guard let self = self else {
                return
            }
            self.foreground.resigned = true
            guard let session = self.currentSession() else {
                return
            }
            MainActor.assumeIsolated {
                session.disableUntilActive()
            }
        })
        observers.append(center.addObserver(
            forName: UIApplication.didBecomeActiveNotification,
            object: nil,
            queue: .main
        ) { [weak self] _ in
            guard let self = self else {
                return
            }
            self.foreground.resigned = false
            guard let session = self.currentSession() else {
                return
            }
            MainActor.assumeIsolated {
                if session.presented {
                    session.restartEnableGuard()
                }
            }
        })
    }

    deinit {
        for observer in observers {
            NotificationCenter.default.removeObserver(observer)
        }
    }

    /// uniffi foreign-trait entry point. Never on main. Blocks until answered.
    func confirm(req: ConfirmPayload) throws -> Bool {
        dispatchPrecondition(condition: .notOnQueue(.main))
        // Copy the core rendered is shown verbatim. Anything the alert could
        // not show honestly (an empty title or button, an unknown style) is a
        // decline, never a guess.
        guard let tone = Self.renderableTone(req) else {
            return false
        }

        let session = ConsentSession(enableDelay: enableDelay, foreground: foreground)
        lock.lock()
        if current != nil {
            lock.unlock()
            return false
        }
        current = session
        lock.unlock()

        DispatchQueue.main.async { [self] in
            MainActor.assumeIsolated {
                present(session, req, tone)
            }
        }

        var answer = session.settlement.wait(timeout: timeout)
        if answer == nil {
            // Timed out: decline. If a tap won the race, settle returns
            // false and the recorded answer stands.
            session.settlement.settle(false)
            answer = session.settlement.wait(timeout: 0)
        }

        // Queue the dismissal BEFORE freeing the slot: main runs blocks in
        // order, so the next request's presentation sees a clean hierarchy.
        DispatchQueue.main.async {
            MainActor.assumeIsolated {
                session.dismissIfNeeded()
            }
        }
        lock.lock()
        if current === session {
            current = nil
        }
        lock.unlock()

        return answer == true
    }

    /// Dismiss the open consent alert (if any) and answer it false. Any thread; never blocks
    /// waiting on main.
    func declineAll() {
        guard let session = currentSession() else {
            return
        }
        // Settle here, not on main: the waiting caller is released at once
        // even if main is busy, and a request still waiting to be presented
        // sees the decline and never shows.
        session.settlement.settle(false)
        DispatchQueue.main.async {
            MainActor.assumeIsolated {
                session.dismissIfNeeded()
            }
        }
    }

    /// Thread-safe: true while a request holds the one slot (pending or presented).
    var isBusy: Bool {
        currentSession() != nil
    }

    /// Main thread only: the top-most view controller of the key window, or nil.
    static func topMostViewController() -> UIViewController? {
        dispatchPrecondition(condition: .onQueue(.main))
        return MainActor.assumeIsolated {
            let scenes = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
            var window = scenes.first { $0.activationState == .foregroundActive }?.keyWindow
            if window == nil {
                // No scene delegate here; fall back to whichever window is key
                // in any connected scene (the non-deprecated form of
                // `UIApplication.windows`).
                window = scenes.lazy.flatMap { $0.windows }.first { $0.isKeyWindow }
            }
            var top = window?.rootViewController
            while let presented = top?.presentedViewController {
                top = presented
            }
            return top
        }
    }

    /// Main thread only. TEST HOOK: the alert currently presented by this instance.
    var presentedAlertForTesting: UIAlertController? {
        dispatchPrecondition(condition: .onQueue(.main))
        guard let session = currentSession() else {
            return nil
        }
        return MainActor.assumeIsolated {
            guard session.presented, !session.isSettled else {
                return nil
            }
            return session.alert
        }
    }

    /// Main thread only. TEST HOOK: settle the open dialog exactly as its confirm (true) or
    /// cancel (false) button handler would.
    ///
    /// Like a real tap, a confirm during the `enableDelay` window is ignored.
    func completeForTesting(confirmed: Bool) {
        dispatchPrecondition(condition: .onQueue(.main))
        guard let session = currentSession() else {
            return
        }
        MainActor.assumeIsolated {
            session.buttonPressed(confirmed: confirmed)
        }
    }

    // MARK: - Private

    private func currentSession() -> ConsentSession? {
        lock.lock()
        defer { lock.unlock() }
        return current
    }

    private static func renderableTone(_ req: ConfirmPayload) -> ConsentTone? {
        for text in [req.title, req.message, req.confirmLabel, req.cancelLabel]
        where text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            return nil
        }
        guard req.defaultButton == "cancel" || req.defaultButton == "confirm" else {
            return nil
        }
        switch req.kind {
        case "warning": return .warning
        case "info": return .info
        default: return nil
        }
    }

    /// A host we can present on: in a window, not mid-transition, not already
    /// presenting, and not someone's alert (stacking alerts is how a consent
    /// dialog ends up hidden behind, or confused with, another one).
    @MainActor private static func canPresent(from host: UIViewController) -> Bool {
        if host is UIAlertController {
            return false
        }
        if host.isBeingPresented || host.isBeingDismissed {
            return false
        }
        if host.presentedViewController != nil {
            return false
        }
        return host.viewIfLoaded?.window != nil
    }

    @MainActor private func present(_ session: ConsentSession, _ req: ConfirmPayload, _ tone: ConsentTone) {
        // Declined (teardown or timeout) before main got here: show nothing.
        guard !session.isSettled else {
            return
        }
        guard let host = presenter(), Self.canPresent(from: host) else {
            session.settle(false)
            return
        }

        let alert = ConsentAlertController(title: req.title, message: req.message, preferredStyle: .alert)
        alert.session = session
        let cancel = UIAlertAction(title: req.cancelLabel, style: .cancel) { _ in
            MainActor.assumeIsolated {
                session.buttonPressed(confirmed: false)
            }
        }
        let confirmStyle: UIAlertAction.Style = tone == .warning ? .destructive : .default
        let confirm = UIAlertAction(title: req.confirmLabel, style: confirmStyle) { _ in
            MainActor.assumeIsolated {
                session.buttonPressed(confirmed: true)
            }
        }
        // Disabled until the alert has been in view for `enableDelay`, so a
        // tap aimed at what was under it, or timed to its arrival or its
        // re-appearance, cannot consent (Android's 700 ms guard).
        confirm.isEnabled = false
        alert.addAction(cancel)
        alert.addAction(confirm)
        alert.preferredAction = req.defaultButton == "cancel" ? cancel : confirm

        session.alert = alert
        session.confirmAction = confirm

        host.present(alert, animated: true) {
            MainActor.assumeIsolated {
                session.presented = true
                if session.isSettled || session.dismissWhenPresented {
                    session.dismissIfNeeded()
                    return
                }
                session.restartEnableGuard()
            }
        }

        // A presentation UIKit silently refused never runs its completion.
        DispatchQueue.main.asyncAfter(deadline: .now() + presentationDeadline) {
            MainActor.assumeIsolated {
                if !session.presented {
                    session.settle(false)
                }
            }
        }
    }
}
