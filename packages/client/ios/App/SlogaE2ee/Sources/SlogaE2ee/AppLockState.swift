// AppLockState.swift: the app lock of this device (app lock plan 4, 6.1 to
// 6.3, 6.6): whether it is on, whether the app is locked right now, the
// cover window drawn over everything, and the unlock prompt. One per
// process. It works without AppLockPlugin, which is only the web layer's
// window onto it.
//
// Whether the app is unlocked is kept in memory only and starts false, so a
// new process is locked whenever the lock is on. Only a prompt the user
// passed sets it. Settings that cannot be read count as "on", and are read
// again on the next return to the foreground.
//
// The settings live in one Keychain item that never leaves this device.
// A Keychain item survives a reinstall, so the first run after an install
// deletes it. An empty marker file in Application Support tells that first
// run apart from the later ones.
//
// Threading: main thread only. The calls that return a value check that.
// The calls that return nothing hop to main when called from elsewhere.
// Every completion runs on the main thread, exactly once.
//
// Nothing here is logged.
import Foundation
import LocalAuthentication
import Security
import UIKit

/// Main thread only. The conformance exists so closures can carry the one
/// instance back to the main queue.
final class AppLockState: @unchecked Sendable {
    static let shared = AppLockState()

    /// Called on the main thread after the lock state changed, and whenever
    /// the app comes back still locked with the cover up.
    var onLockChanged: ((_ locked: Bool, _ enabled: Bool) -> Void)?

    static let codeNoDeviceLock = "NO_DEVICE_LOCK"
    static let codeCancelled = "CANCELLED"
    static let codeLocked = "LOCKED"
    static let codeFailed = "FAILED"

    private static let service = "gg.sloga.applock"
    private static let account = "state"
    /// Marker file in Application Support: this install has run before.
    private static let installedMarkerName = "applock.installed"

    /// How long the cover waits for the web lock screen before it offers its own Unlock.
    private static let coverButtonDelay: TimeInterval = 4

    private enum DeviceSecurity {
        case secure
        case notSecure
        /// The phone could not say whether it has a passcode.
        case unknown
    }

    private enum Stored {
        /// No item: the lock is off.
        case off
        case value(enabled: Bool, timeoutSec: Int)
        /// The item could not be read or understood.
        case unknown
    }

    /// One enable, disable or unlock request. Answered exactly once.
    private final class Request: @unchecked Sendable {
        enum Kind {
            case unlock
            case enable
            case disable
        }

        let kind: Kind
        var unlockDone: ((Bool) -> Void)?
        var codeDone: ((String?) -> Void)?
        var finished = false

        init(kind: Kind, unlockDone: ((Bool) -> Void)?, codeDone: ((String?) -> Void)?) {
            self.kind = kind
            self.unlockDone = unlockDone
            self.codeDone = codeDone
        }
    }

    // Until the settings are read they count as on.
    private var enabled = true
    private var timeout = 0
    /// False while the last read of the settings failed.
    private var stateKnown = false
    /// The first-run purge is done, or was not needed.
    private var purgeChecked = false

    /// Set only by a prompt the user passed. Never saved.
    private var unlocked = false
    /// The session ended while locked: stay locked although the lock is now off.
    private var stickyLocked = false
    /// An auto-off happened and the web layer has not been told yet.
    private var autoDisabled = false

    /// continuousNow() when the app last went to the background, or nil.
    private var leftAt: TimeInterval?

    private var started = false
    /// Between didBecomeActive and willResignActive.
    private var active = false
    /// Between willEnterForeground and didEnterBackground.
    private var inForeground = false

    /// The web lock screen of the current page reported in since the app
    /// last came to the foreground.
    private var gateUp = false
    /// willEnterForeground already told the web layer about this return.
    private var notifiedThisReturn = false
    /// The next didBecomeActive ends a prompt's own resign and return, and
    /// must not make the web layer ask again.
    private var skipActiveNotify = false

    /// The request whose prompt is open or waiting to open, or nil. It only
    /// stops a second prompt from opening and never feeds the lock decision.
    private var prompt: Request?
    private var promptContext: LAContext?
    /// The prompt waits for the app to become active before it opens.
    private var promptParked = false

    /// The cover and its button. Both nil while the cover is down.
    private var coverWindow: UIWindow?
    private var coverButton: UIButton?
    private var coverTimerGeneration = 0

    private var observers: [NSObjectProtocol] = []

    private init() {}

    // MARK: State

    var isEnabled: Bool {
        ensureStarted()
        return enabled
    }

    var isLocked: Bool {
        ensureStarted()
        return locked
    }

    var timeoutSec: Int {
        ensureStarted()
        return timeout
    }

    /// False only when the phone says for certain that it has no passcode.
    /// A phone that cannot answer counts as having one, so the lock is never
    /// turned off on a failed query.
    var isDeviceSecure: Bool {
        dispatchPrecondition(condition: .onQueue(.main))
        return Self.deviceSecurity() != .notSecure
    }

    /// True once after the lock turned itself off.
    func consumeAutoDisabled() -> Bool {
        ensureStarted()
        let was = autoDisabled
        autoDisabled = false
        return was
    }

    /// Seconds on a clock that keeps counting while the phone sleeps and
    /// ignores wall-clock changes. Not a number when the clock cannot be
    /// read, which AppLockPolicy treats as "lock".
    static func continuousNow() -> TimeInterval {
        guard let timebase = timebase else {
            return .nan
        }
        return Double(mach_continuous_time()) * timebase.numer / timebase.denom / 1_000_000_000
    }

    private static let timebase: (numer: Double, denom: Double)? = {
        var info = mach_timebase_info_data_t()
        guard mach_timebase_info(&info) == KERN_SUCCESS, info.denom != 0 else {
            return nil
        }
        return (Double(info.numer), Double(info.denom))
    }()

    // MARK: Entry points

    /// Load the settings, start watching the app's lifecycle and, if the app
    /// is locked, put the cover up at once. Later calls do nothing.
    func start() {
        onMain {
            self.startImpl()
        }
    }

    /// Ask for the unlock. `auto` is the prompt the app opens by itself; on
    /// iPhone it is treated like any other.
    func authenticate(auto: Bool, completion: @escaping (Bool) -> Void) {
        onMain {
            self.startImpl()
            guard self.locked else {
                completion(true)
                return
            }
            guard self.prompt == nil, self.inForeground else {
                completion(false)
                return
            }
            self.startPrompt(Request(kind: .unlock, unlockDone: completion, codeDone: nil))
        }
    }

    /// Turn the lock on. The completion gets nil on success, otherwise an error code.
    func enable(completion: @escaping (String?) -> Void) {
        onMain {
            self.startImpl()
            self.reloadIfUnknown()
            if Self.deviceSecurity() == .notSecure {
                completion(Self.codeNoDeviceLock)
                return
            }
            guard self.prompt == nil, self.inForeground else {
                completion(Self.codeFailed)
                return
            }
            // A phone that could not say whether it has a passcode gets the
            // prompt anyway, and the prompt decides.
            self.startPrompt(Request(kind: .enable, unlockDone: nil, codeDone: completion))
        }
    }

    /// Turn the lock off. Refused while locked.
    func disable(completion: @escaping (String?) -> Void) {
        onMain {
            self.startImpl()
            if self.locked {
                completion(Self.codeLocked)
                return
            }
            guard self.prompt == nil, self.inForeground else {
                completion(Self.codeFailed)
                return
            }
            self.startPrompt(Request(kind: .disable, unlockDone: nil, codeDone: completion))
        }
    }

    /// False while locked, for a timing that is not offered, while the saved
    /// settings cannot be read, or when it could not be saved.
    func setTimeoutSec(_ sec: Int) -> Bool {
        ensureStarted()
        MainActor.assumeIsolated {
            reloadIfUnknown()
        }
        guard !locked, stateKnown, AppLockPolicy.validTimeout(sec) else {
            return false
        }
        guard save(enabled: enabled, timeoutSec: sec) else {
            return false
        }
        timeout = sec
        return true
    }

    /// The web lock screen is drawn, so the cover can go. Changes nothing
    /// else. Ignored while the app is in the background.
    func gateShown() {
        onMain {
            guard self.started, self.locked, self.inForeground else {
                return
            }
            self.gateUp = true
            // Not active yet: didBecomeActive takes the cover down.
            if self.active {
                self.removeCover()
            }
        }
    }

    /// The session ended. The lock setting is cleared, but an app that was
    /// locked stays locked until a prompt is passed or a new page loads.
    func reset() {
        onMain {
            self.startImpl()
            if self.locked {
                self.stickyLocked = true
            }
            // An enable or disable still waiting on its prompt ends here, so
            // its answer cannot change anything afterwards.
            if let pending = self.prompt, pending.kind != .unlock {
                let context = self.promptContext
                self.finish(pending, Self.codeFailed)
                context?.invalidate()
            }
            // Not saved means the next start is still locked, which is the
            // careful side.
            _ = self.save(enabled: false, timeoutSec: 0)
            self.enabled = false
            self.timeout = 0
            self.stateKnown = true
            self.notify()
        }
    }

    /// A new main-frame page load started. The page that was locked out is
    /// gone, and the new one has not drawn a lock screen yet.
    func pageStarted() {
        onMain {
            guard self.started else {
                return
            }
            self.stickyLocked = false
            self.gateUp = false
            if self.locked {
                self.coverButton?.isHidden = true
                self.showLockedCover()
                if self.active {
                    self.startCoverTimer()
                }
            } else if self.active {
                // Not active: the cover stays for the app switcher, and
                // didBecomeActive takes it down.
                self.removeCover()
            }
            self.notify()
        }
    }

    // MARK: Lifecycle

    private var locked: Bool {
        (enabled || stickyLocked) && !unlocked
    }

    private func ensureStarted() {
        dispatchPrecondition(condition: .onQueue(.main))
        if !started {
            MainActor.assumeIsolated {
                startImpl()
            }
        }
    }

    /// Run on the main thread: now when already there, otherwise soon.
    private func onMain(_ body: @escaping @MainActor () -> Void) {
        if Thread.isMainThread {
            MainActor.assumeIsolated {
                body()
            }
        } else {
            DispatchQueue.main.async {
                MainActor.assumeIsolated {
                    body()
                }
            }
        }
    }

    @MainActor private func startImpl() {
        guard !started else {
            return
        }
        started = true

        let state = UIApplication.shared.applicationState
        active = state == .active
        inForeground = state != .background

        loadState()
        _ = autoOffIfNoPasscode()

        // queue nil: the block runs inside the post, on the main thread, so
        // the cover is up before the app-switcher snapshot is taken.
        let center = NotificationCenter.default
        observers.append(center.addObserver(
            forName: UIApplication.willResignActiveNotification, object: nil, queue: nil
        ) { [self] _ in
            onMain {
                self.willResignActive()
            }
        })
        observers.append(center.addObserver(
            forName: UIApplication.didEnterBackgroundNotification, object: nil, queue: nil
        ) { [self] _ in
            onMain {
                self.didEnterBackground()
            }
        })
        observers.append(center.addObserver(
            forName: UIApplication.willEnterForegroundNotification, object: nil, queue: nil
        ) { [self] _ in
            onMain {
                self.willEnterForeground()
            }
        })
        observers.append(center.addObserver(
            forName: UIApplication.didBecomeActiveNotification, object: nil, queue: nil
        ) { [self] _ in
            onMain {
                self.didBecomeActive()
            }
        })

        if locked {
            showLockedCover()
            if active {
                startCoverTimer()
            }
        }
    }

    /// The app-switcher snapshot is about to be taken. Not a lock event: the
    /// unlock prompt, Control Center and system alerts come through here too.
    @MainActor private func willResignActive() {
        active = false
        cancelCoverTimer()
        if locked {
            showLockedCover()
        } else if enabled {
            showCover()
        }
    }

    @MainActor private func didEnterBackground() {
        active = false
        inForeground = false
        leftAt = Self.continuousNow()
        gateUp = false
        skipActiveNotify = false
        cancelCoverTimer()
        coverButton?.isHidden = true
        if enabled || locked {
            showCover()
        }
        // A prompt that never opened is not going to.
        if promptParked, let pending = prompt {
            promptParked = false
            finish(pending, Self.codeCancelled)
        }
    }

    @MainActor private func willEnterForeground() {
        inForeground = true
        skipActiveNotify = false
        let wasLocked = locked
        let wasEnabled = enabled

        reloadIfUnknown()
        _ = autoOffIfNoPasscode()

        if enabled && unlocked
            && AppLockPolicy.shouldLock(
                enabled: true, coldStart: false, leftAt: leftAt,
                now: Self.continuousNow(), timeoutSec: timeout
            ) {
            unlocked = false
        }
        leftAt = nil

        if locked {
            showLockedCover()
        }
        // Told on every return that is still locked, not only on a change,
        // so the web layer redraws its lock screen and reports in again.
        if locked || locked != wasLocked || enabled != wasEnabled {
            notify()
            notifiedThisReturn = locked
        }
    }

    @MainActor private func didBecomeActive() {
        active = true
        inForeground = true

        if !locked {
            removeCover()
        } else if gateUp {
            // The web lock screen is still drawn under the cover.
            removeCover()
        } else {
            // Also the second try when no scene was there to hold the cover.
            showLockedCover()
            startCoverTimer()
            if !notifiedThisReturn && !skipActiveNotify {
                notify()
            }
        }
        notifiedThisReturn = false
        skipActiveNotify = false

        if promptParked, let pending = prompt {
            promptParked = false
            if pending.kind == .unlock && !locked {
                finish(pending, nil)
            } else {
                beginEvaluation(pending)
            }
        }
    }

    private func notify() {
        onLockChanged?(locked, enabled)
    }

    // MARK: Prompts

    /// Open the system prompt for one request, or hold it until the app is
    /// active: a prompt asked for before that is cancelled by the system.
    @MainActor private func startPrompt(_ request: Request) {
        prompt = request
        if active {
            beginEvaluation(request)
        } else {
            promptParked = true
        }
    }

    @MainActor private func beginEvaluation(_ request: Request) {
        // A fresh context per prompt: a used one can answer from its cache.
        let context = LAContext()
        promptContext = context
        // Face ID and the passcode sheet make the app resign and return.
        skipActiveNotify = true
        let reason = Self.reason(request.kind)
        context.evaluatePolicy(
            .deviceOwnerAuthentication, localizedReason: reason
        ) { @Sendable ok, error in
            let laCode: Int?
            if let error = error as NSError?, error.domain == LAErrorDomain {
                laCode = error.code
            } else {
                laCode = nil
            }
            // The reply arrives on a private queue. Nothing of this object
            // is touched until the hop to main.
            DispatchQueue.main.async {
                MainActor.assumeIsolated {
                    self.promptReplied(request, ok: ok, laCode: laCode)
                }
            }
        }
    }

    private static func reason(_ kind: Request.Kind) -> String {
        switch kind {
        case .unlock:
            return "Unlock Sloga"
        case .enable:
            return "Turn on app lock"
        case .disable:
            return "Turn off app lock"
        }
    }

    @MainActor private func promptReplied(_ request: Request, ok: Bool, laCode: Int?) {
        // A reply for a request that was already answered changes nothing.
        guard !request.finished else {
            return
        }
        if ok {
            promptSucceeded(request)
        } else {
            promptFailed(request, laCode: laCode)
        }
    }

    @MainActor private func promptSucceeded(_ request: Request) {
        switch request.kind {
        case .unlock:
            unlocked = true
            stickyLocked = false
        case .enable:
            guard save(enabled: true, timeoutSec: timeout) else {
                finish(request, Self.codeFailed)
                return
            }
            enabled = true
            stateKnown = true
            unlocked = true
            stickyLocked = false
        case .disable:
            guard save(enabled: false, timeoutSec: timeout) else {
                finish(request, Self.codeFailed)
                return
            }
            enabled = false
            stateKnown = true
        }
        gateUp = false
        // Not active yet (the prompt is still closing): didBecomeActive
        // takes the cover down.
        if active && !locked {
            removeCover()
        }
        notify()
        finish(request, nil)
    }

    @MainActor private func promptFailed(_ request: Request, laCode: Int?) {
        let code: String
        // Int.min is no LocalAuthentication code, so "no code" lands in default.
        switch laCode ?? Int.min {
        case LAError.Code.userCancel.rawValue,
             LAError.Code.appCancel.rawValue,
             LAError.Code.systemCancel.rawValue:
            code = Self.codeCancelled
        case LAError.Code.passcodeNotSet.rawValue:
            code = Self.codeNoDeviceLock
        default:
            code = Self.codeFailed
        }
        if laCode == LAError.Code.passcodeNotSet.rawValue {
            // The passcode may have been removed while the app was open. The
            // phone is asked again, and only its own answer turns the lock off.
            if autoOffIfNoPasscode() {
                if active && !locked {
                    removeCover()
                }
                notify()
            }
        }
        finish(request, code)
    }

    /// Answer a request, once. A nil code is success.
    private func finish(_ request: Request, _ code: String?) {
        guard !request.finished else {
            return
        }
        request.finished = true
        if prompt === request {
            prompt = nil
            promptContext = nil
            promptParked = false
        }
        let unlockDone = request.unlockDone
        let codeDone = request.codeDone
        request.unlockDone = nil
        request.codeDone = nil
        unlockDone?(code == nil)
        codeDone?(code)
    }

    // MARK: Phone state

    private static func deviceSecurity() -> DeviceSecurity {
        var error: NSError?
        if LAContext().canEvaluatePolicy(.deviceOwnerAuthentication, error: &error) {
            return .secure
        }
        if let error = error, error.domain == LAErrorDomain,
           error.code == LAError.Code.passcodeNotSet.rawValue {
            return .notSecure
        }
        return .unknown
    }

    /// Turn the lock off when the phone says for certain that it has no
    /// passcode. Returns whether it did. The caller redraws and notifies.
    /// Never on settings that could not be read: "on" is only assumed then.
    private func autoOffIfNoPasscode() -> Bool {
        guard stateKnown, enabled, Self.deviceSecurity() == .notSecure else {
            return false
        }
        // Not saved means the next start asks the phone again.
        _ = save(enabled: false, timeoutSec: timeout)
        enabled = false
        autoDisabled = true
        return true
    }

    // MARK: Storage

    @MainActor private func reloadIfUnknown() {
        if !stateKnown {
            loadState()
        }
    }

    /// Read the saved settings. Anything short of a clean answer leaves the
    /// lock on and the read to be tried again.
    @MainActor private func loadState() {
        if !purgeChecked {
            if !Self.hasInstalledMarker() {
                // Wait until the phone's storage is open, so a marker that
                // cannot be seen yet is not taken for a fresh install.
                // Deleting then would turn a live lock off.
                guard UIApplication.shared.isProtectedDataAvailable else {
                    applyUnknown()
                    return
                }
                let status = SecItemDelete(Self.baseQuery() as CFDictionary)
                guard status == errSecSuccess || status == errSecItemNotFound else {
                    applyUnknown()
                    return
                }
                // A marker that could not be written is tried again on the
                // next start, not in this one.
                _ = Self.writeInstalledMarker()
            }
            purgeChecked = true
        }

        switch Self.readStored() {
        case .off:
            enabled = false
            timeout = 0
            stateKnown = true
        case .value(let storedEnabled, let storedTimeout):
            enabled = storedEnabled
            timeout = storedTimeout
            stateKnown = true
        case .unknown:
            applyUnknown()
        }
    }

    private func applyUnknown() {
        enabled = true
        timeout = 0
        stateKnown = false
    }

    private static func baseQuery() -> [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecAttrSynchronizable as String: false,
        ]
    }

    private static func readStored() -> Stored {
        var query = baseQuery()
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var out: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &out)
        if status == errSecItemNotFound {
            return .off
        }
        guard status == errSecSuccess, let data = out as? Data else {
            return .unknown
        }
        guard let object = try? JSONSerialization.jsonObject(with: data),
              let fields = object as? [String: Any],
              let storedEnabled = fields["enabled"] as? Bool
        else {
            return .unknown
        }
        // A timing that is not offered reads as the strictest one.
        let storedTimeout = fields["timeoutSec"] as? Int ?? 0
        return .value(
            enabled: storedEnabled,
            timeoutSec: AppLockPolicy.validTimeout(storedTimeout) ? storedTimeout : 0
        )
    }

    private static func installedMarkerURL() -> URL? {
        FileManager.default
            .urls(for: .applicationSupportDirectory, in: .userDomainMask)
            .first?
            .appendingPathComponent(installedMarkerName, isDirectory: false)
    }

    private static func hasInstalledMarker() -> Bool {
        guard let url = installedMarkerURL() else {
            return false
        }
        return FileManager.default.fileExists(atPath: url.path)
    }

    /// Write the marker, making Application Support first if it is missing.
    /// Returns whether the marker is there afterwards.
    private static func writeInstalledMarker() -> Bool {
        guard let url = installedMarkerURL() else {
            return false
        }
        let files = FileManager.default
        if files.fileExists(atPath: url.path) {
            return true
        }
        try? files.createDirectory(
            at: url.deletingLastPathComponent(), withIntermediateDirectories: true,
            attributes: nil
        )
        return files.createFile(atPath: url.path, contents: Data(), attributes: nil)
    }

    /// Save the settings. A saved item belongs to this install, so the
    /// marker is written with it and the first-run purge is over: otherwise
    /// the next start would delete what was just saved.
    private func save(enabled: Bool, timeoutSec: Int) -> Bool {
        guard Self.writeItem(enabled: enabled, timeoutSec: timeoutSec) else {
            return false
        }
        _ = Self.writeInstalledMarker()
        purgeChecked = true
        return true
    }

    private static func writeItem(enabled: Bool, timeoutSec: Int) -> Bool {
        let fields: [String: Any] = ["enabled": enabled, "timeoutSec": timeoutSec]
        guard let data = try? JSONSerialization.data(withJSONObject: fields) else {
            return false
        }
        let attributes: [String: Any] = [
            kSecValueData as String: data,
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
        ]
        var status = SecItemUpdate(baseQuery() as CFDictionary, attributes as CFDictionary)
        if status == errSecItemNotFound {
            var item = baseQuery()
            for (key, value) in attributes {
                item[key] = value
            }
            status = SecItemAdd(item as CFDictionary, nil)
            if status == errSecDuplicateItem {
                status = SecItemUpdate(baseQuery() as CFDictionary, attributes as CFDictionary)
            }
        }
        return status == errSecSuccess
    }

    // MARK: The cover

    /// The scene the cover goes on: the one in front if there is one.
    @MainActor private func coverScene() -> UIWindowScene? {
        let scenes = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
        return scenes.first { $0.activationState == .foregroundActive }
            ?? scenes.first { $0.activationState == .foregroundInactive }
            ?? scenes.first
    }

    /// Put the cover up. It is its own window above alerts, sheets and
    /// pickers. It is never made key, so the web view keeps its place as
    /// first responder; touches still reach the cover because it is on top.
    /// With no scene yet, nothing happens and didBecomeActive tries again.
    @MainActor private func showCover() {
        if let window = coverWindow {
            if window.windowScene != nil {
                window.isHidden = false
                return
            }
            // Its scene is gone.
            removeCover()
        }
        guard let scene = coverScene() else {
            return
        }

        let window = UIWindow(windowScene: scene)
        window.windowLevel = UIWindow.Level(rawValue: UIWindow.Level.alert.rawValue + 1)
        window.backgroundColor = .systemBackground
        window.isOpaque = true
        // A screen reader must not read the chat under the cover.
        window.accessibilityViewIsModal = true

        let controller = UIViewController()
        let root: UIView = controller.view
        root.backgroundColor = .systemBackground
        root.isOpaque = true

        let title = UILabel()
        title.translatesAutoresizingMaskIntoConstraints = false
        title.text = "Sloga"
        title.font = .preferredFont(forTextStyle: .largeTitle)
        title.adjustsFontForContentSizeCategory = true
        title.textColor = .label
        title.textAlignment = .center
        root.addSubview(title)

        let action = UIAction(title: "Unlock") { [weak self] _ in
            guard let self = self else {
                return
            }
            self.authenticate(auto: false) { _ in }
        }
        let button = UIButton(type: .system, primaryAction: action)
        button.translatesAutoresizingMaskIntoConstraints = false
        button.titleLabel?.font = .preferredFont(forTextStyle: .headline)
        button.titleLabel?.adjustsFontForContentSizeCategory = true
        button.isHidden = true
        root.addSubview(button)

        NSLayoutConstraint.activate([
            title.centerXAnchor.constraint(equalTo: root.centerXAnchor),
            title.centerYAnchor.constraint(equalTo: root.centerYAnchor),
            title.leadingAnchor.constraint(greaterThanOrEqualTo: root.leadingAnchor, constant: 24),
            button.centerXAnchor.constraint(equalTo: root.centerXAnchor),
            button.topAnchor.constraint(equalTo: title.bottomAnchor, constant: 24),
            button.heightAnchor.constraint(greaterThanOrEqualToConstant: 44),
        ])

        window.rootViewController = controller
        window.isHidden = false
        coverWindow = window
        coverButton = button
    }

    /// The cover for a locked app. The keyboard goes too: it sits above
    /// every window, and what is typed would reach the page under the cover.
    @MainActor private func showLockedCover() {
        showCover()
        guard let cover = coverWindow, let scene = cover.windowScene else {
            return
        }
        for window in scene.windows where window !== cover {
            window.endEditing(true)
        }
    }

    /// Take the cover down and let go of its window.
    @MainActor private func removeCover() {
        cancelCoverTimer()
        guard let window = coverWindow else {
            return
        }
        coverWindow = nil
        coverButton = nil
        let wasKey = window.isKeyWindow
        let scene = window.windowScene
        window.isHidden = true
        window.rootViewController = nil
        // It is never made key here. If the system did it anyway, the app's
        // own window gets the place back.
        if wasKey {
            scene?.windows.first {
                $0 !== window && !$0.isHidden && $0.windowLevel == .normal
            }?.makeKey()
        }
    }

    /// Still locked and still covered after the delay: the web lock screen
    /// did not report in, so the cover offers the unlock itself.
    @MainActor private func startCoverTimer() {
        coverTimerGeneration &+= 1
        let generation = coverTimerGeneration
        DispatchQueue.main.asyncAfter(deadline: .now() + Self.coverButtonDelay) {
            MainActor.assumeIsolated {
                guard generation == self.coverTimerGeneration, self.active, self.locked,
                      self.coverWindow != nil
                else {
                    return
                }
                self.coverButton?.isHidden = false
            }
        }
    }

    private func cancelCoverTimer() {
        coverTimerGeneration &+= 1
    }
}
