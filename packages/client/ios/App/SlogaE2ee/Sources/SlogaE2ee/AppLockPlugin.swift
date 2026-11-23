// AppLockPlugin.swift: the Capacitor plugin `AppLock` (app lock, iPhone
// wave). A thin layer over `AppLockState.shared`, with the Android plugin's
// contract: the same method names, the same result shapes and the same
// reject codes. It holds no lock state of its own and makes no lock
// decision; the cover window and the lock itself are started by the bridge
// view controller and work without this plugin.
//
// Methods:
//   getState                 { enabled, locked, timeoutSec,
//                              hideNotificationText, deviceSecure,
//                              autoDisabled }
//   enable, disable          { enabled }
//   authenticate { auto? }   { unlocked }
//   setTimeout { sec }       {}
//   setHideNotificationText  always rejects FAILED: not available on iPhone,
//                            and `hideNotificationText` is always false
//   gateShown, reset         {}
// Event `lockChanged` carries { locked, enabled }.
//
// Errors reject with a fixed code (message and code are the same string):
// NO_DEVICE_LOCK, CANCELLED, LOCKED or FAILED. Never an OS error's text.
// A code from the state that is not one of these is sent as FAILED.
//
// Threading. Capacitor calls these methods on its bridge queue. Each one
// reads its arguments there and hands off to the main queue, the only place
// `AppLockState` is touched. Calls resolve and reject on the main queue too.
//
// Fail closed. `getState` has one success path, which reads `isLocked` on
// the main queue, and no path that fills in a default: when it cannot read
// the state it rejects, it never resolves `locked: false`.
//
// Arming: like E2eePlugin and SlogaCallAudioPlugin, every method first
// checks a flag that only SlogaBridgeViewController sets
// (`AppLockPlugin.arm()`), right after the main-frame bridge guard is
// installed. Capacitor can also create a plugin on its own, by class name,
// for a message naming an unregistered plugin id (E2eePlugin.swift explains
// the path), so without the flag a frame the guard would have stopped could
// raise the passcode prompt or reset the lock in a process where the guard
// failed to install. Unarmed, every method rejects FAILED and `load()` does
// not take the `lockChanged` hook.
//
// Nothing here is logged.
import Capacitor
import Foundation

@objc(AppLockPlugin)
public final class AppLockPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "AppLockPlugin"
    public let jsName = "AppLock"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "getState", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "enable", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "disable", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "authenticate", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setTimeout", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setHideNotificationText", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "gateShown", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "reset", returnType: CAPPluginReturnPromise),
    ]

    static let lockChangedEvent = "lockChanged"

    private static let armLock = NSLock()
    private static var armed = false

    /// Called once by the bridge view controller after the main-frame
    /// bridge guard is in place, before it registers this plugin.
    static func arm() {
        armLock.lock()
        armed = true
        armLock.unlock()
    }

    private static func isArmed() -> Bool {
        armLock.lock()
        let isArmed = armed
        armLock.unlock()
        return isArmed
    }

    private static func armedOrReject(_ call: CAPPluginCall) -> Bool {
        let isArmed = isArmed()
        if !isArmed {
            reject(call, .failed)
        }
        return isArmed
    }

    /// The fixed reject codes (see the header). Never an OS message.
    private enum Failure: String {
        case noDeviceLock = "NO_DEVICE_LOCK"
        case cancelled = "CANCELLED"
        case locked = "LOCKED"
        case failed = "FAILED"
    }

    private static func reject(_ call: CAPPluginCall, _ failure: Failure) {
        // No `error` argument: Capacitor would forward its description.
        call.reject(failure.rawValue, failure.rawValue)
    }

    /// Runs `work` on the main queue: at once if already there.
    private static func onMain(_ work: @escaping () -> Void) {
        if Thread.isMainThread {
            work()
        } else {
            DispatchQueue.main.async(execute: work)
        }
    }

    override public func load() {
        super.load()
        // An instance Capacitor made by class name in a process that never
        // armed the plugin wires nothing.
        guard Self.isArmed() else { return }
        // Weak: the hook lives in the shared state, which must not keep a
        // plugin alive after Capacitor drops it. The last instance loaded
        // wins, as in Capacitor's own plugin table (the one the page talks
        // to).
        let hook: (Bool, Bool) -> Void = { [weak self] locked, enabled in
            // Emit on main, where Capacitor clears a page's listeners on
            // navigation, so this never walks the listener table while that
            // reset runs.
            Self.onMain {
                self?.notifyListeners(
                    Self.lockChangedEvent,
                    data: ["locked": locked, "enabled": enabled]
                )
            }
        }
        Self.onMain {
            AppLockState.shared.onLockChanged = hook
        }
    }

    @objc func getState(_ call: CAPPluginCall) {
        guard Self.armedOrReject(call) else { return }
        Self.onMain {
            let state = AppLockState.shared
            call.resolve([
                "enabled": state.isEnabled,
                "locked": state.isLocked,
                "timeoutSec": state.timeoutSec,
                "hideNotificationText": false,
                "deviceSecure": state.isDeviceSecure,
                // Read once: the state forgets it after this.
                "autoDisabled": state.consumeAutoDisabled(),
            ])
        }
    }

    @objc func enable(_ call: CAPPluginCall) {
        guard Self.armedOrReject(call) else { return }
        Self.onMain {
            AppLockState.shared.enable { code in
                Self.settleEnabled(call, code)
            }
        }
    }

    @objc func disable(_ call: CAPPluginCall) {
        guard Self.armedOrReject(call) else { return }
        Self.onMain {
            AppLockState.shared.disable { code in
                Self.settleEnabled(call, code)
            }
        }
    }

    /// Ends an `enable` or `disable`: nil is success, anything else a code.
    private static func settleEnabled(_ call: CAPPluginCall, _ code: String?) {
        onMain {
            if let code = code {
                reject(call, Failure(rawValue: code) ?? .failed)
            } else {
                call.resolve(["enabled": AppLockState.shared.isEnabled])
            }
        }
    }

    @objc func authenticate(_ call: CAPPluginCall) {
        guard Self.armedOrReject(call) else { return }
        let auto = call.getBool("auto", false)
        Self.onMain {
            AppLockState.shared.authenticate(auto: auto) { unlocked in
                Self.onMain {
                    call.resolve(["unlocked": unlocked])
                }
            }
        }
    }

    @objc func setTimeout(_ call: CAPPluginCall) {
        guard Self.armedOrReject(call) else { return }
        let sec = Self.integer(call, "sec")
        Self.onMain {
            let state = AppLockState.shared
            guard let sec = sec, state.setTimeoutSec(sec) else {
                Self.reject(call, state.isLocked ? .locked : .failed)
                return
            }
            call.resolve()
        }
    }

    /// A whole number argument, or nil. A boolean is refused: it arrives as
    /// an NSNumber too, and `false` would otherwise read as 0, a valid
    /// timeout. A fraction is refused by the exact `Int` cast.
    private static func integer(_ call: CAPPluginCall, _ key: String) -> Int? {
        guard let number = call.options?[key] as? NSNumber,
              CFGetTypeID(number) != CFBooleanGetTypeID() else {
            return nil
        }
        return number as? Int
    }

    @objc func setHideNotificationText(_ call: CAPPluginCall) {
        // Not available on iPhone, armed or not.
        Self.reject(call, .failed)
    }

    @objc func gateShown(_ call: CAPPluginCall) {
        guard Self.armedOrReject(call) else { return }
        Self.onMain {
            AppLockState.shared.gateShown()
            call.resolve()
        }
    }

    @objc func reset(_ call: CAPPluginCall) {
        guard Self.armedOrReject(call) else { return }
        Self.onMain {
            AppLockState.shared.reset()
            call.resolve()
        }
    }
}
