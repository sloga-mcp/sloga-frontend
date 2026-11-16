// CallAudioSession.swift: the Capacitor plugin `SlogaCallAudio` (iOS call
// E2EE phase 2, D9 / C6). It holds the app's AVAudioSession active as a
// voice call (`.playAndRecord`, mode `.voiceChat`) while a call is live, and
// releases it when the call ends. Two promise methods, `start` and `stop`,
// and nothing else; it never touches the E2EE engine.
//
// Why it exists (D9): with `UIBackgroundModes = [audio]` in Info.plist, iOS
// keeps an app running in the background, including with the screen locked,
// only while it holds an active audio session that plays or records. Without
// one a call dies when the user locks the phone. On Android the same job is
// done by the call foreground service; on iOS the page calls `start` where
// Android starts that service and `stop` where it stops it.
//
// App Store Guideline 2.5.4: background modes may be used only for their
// intended purpose; the `audio` mode must not keep the app alive outside a
// call. So the session is activated ONLY by `start` (a call going live) and
// released by `stop`. This file activates nothing on load, at launch or on
// any event of its own. The caller (the page) owns the bracket: a `start`
// without a matching `stop` would keep the session, and with it the app,
// alive in the background, so every call-teardown path must call `stop`.
// A page that is gone cannot call `stop`: a reload or navigation, or a
// WebContent process crash, in the middle of a call would otherwise leave
// the session, and the app, alive in the background. So the bridge view
// controller calls `SlogaCallAudioPlugin.releaseAfterPageLoss()` (native
// only, not a plugin method) when the main frame starts a new load and when
// the web content process terminates. It runs the same idempotent
// deactivation as `stop` on the same queue, needs no arming (it can only
// release), and never blocks its caller; a failure there is dropped, since
// there is no page left to tell.
//
// Interaction with WebKit (UNVERIFIED, from memory unless marked): WebKit
// manages the same app audio session for the page's own media. While
// `getUserMedia` capture runs it puts the session in `.playAndRecord`, and it
// changes the category again as the page's media changes (playback only,
// muted, nothing). Since iOS 16 or so, WebKit's media runs in its GPU process,
// which drives the app's session on the app's behalf; exactly how that
// composes with a category set here is unknown. Consequences:
//   - what this plugin sets is not authoritative while WebKit is capturing:
//     WebKit may override the category, mode or options. What D9 needs is
//     only that the app holds an active play-and-record session, so the
//     background mode applies; the wave's live leg (screen locked, mic live)
//     is the measurement, not this comment;
//   - deactivating while audio I/O is still running (VERIFIED in the iOS 26.5
//     SDK header, AVAudioSession.h, `setActive`): since iOS 8 the session IS
//     deactivated but the call fails with `isBusy`, and since iOS 26.0 it no
//     longer returns `isBusy`. Whether WebKit's out-of-process capture
//     counts as this session's running I/O is UNVERIFIED; assume a `stop`
//     sent while the page still captures takes the session away from that
//     capture. So the page must call `stop` only after the room has
//     disconnected and its tracks have stopped;
//   - `navigator.audioSession` (WebKit's Audio Session API) is the web-side
//     way to ask for a session type. It is not used: whether it keeps the
//     app alive under the background mode is UNVERIFIED, and this plugin
//     gives the app a session it controls directly.
//
// Interruptions (UNVERIFIED): an incoming cellular call or an alarm makes
// the system deactivate the session. This plugin does not observe
// interruptions, so its own state still says active and a later `start` is a
// no-op. The page can force a fresh activation with `stop` then `start`.
//
// Threading. `setActive` is synchronous and may block (VERIFIED, the SDK
// header: "activating an audio session is a synchronous (blocking) operation.
// Therefore, we recommend that applications not activate their session from a
// thread where a long blocking operation will be problematic."). So both
// methods hand off to ONE private serial queue and return at once:
//   - never the main thread (it would freeze the UI);
//   - not Capacitor's bridge queue, which the methods are called on: blocking
//     it would hold every other plugin call queued behind this one, including
//     E2ee's, which only read their arguments there and hand off;
//   - not the E2EE engine or call workers (Support.swift): this never calls
//     the engine, and a call commit must not wait behind an audio activation,
//     nor an activation behind a decrypt burst;
//   - serial, so a `start` and a `stop` take effect in the order the page
//     sent them, and `active` is read and written on that queue only (no
//     lock).
// The session is process-wide, so the queue and the state are static: two
// plugin instances (Capacitor can create one by class name) share them.
//
// Idempotent: a `start` while this plugin holds the session active, and a
// `stop` while it does not, resolve without touching the session. A `start`
// that fails leaves the state inactive, so the next `start` tries again; a
// `stop` that fails leaves it active, so the next `stop` tries again, except
// on `isBusy`, which (per the SDK header) means the session was
// deactivated anyway, so the state goes inactive and `stop` resolves.
//
// Errors reject with a fixed code (message and code are the same string):
// never the OS error's text, domain or number.
//   call_audio_unavailable            the plugin is not armed (see `arm`)
//   call_audio_category_failed        setCategory threw
//   call_audio_insufficient_priority  another app (a phone call) holds audio
//   call_audio_activate_failed        setActive(true) threw, any other reason
//   call_audio_deactivate_failed      setActive(false) threw (not isBusy)
//
// Arming: like E2eePlugin, every method first checks a flag that only
// SlogaBridgeViewController sets (`SlogaCallAudioPlugin.arm()`), right after
// the main-frame bridge guard is installed. Capacitor can also create a
// plugin on its own, by class name, for a message naming an unregistered
// plugin id (E2eePlugin.swift explains the path), so without the flag a
// frame the guard would have stopped could hold the app's audio session,
// and keep the app alive in the background, in a process where the guard
// failed to install. Unarmed, both methods reject `call_audio_unavailable`.
//
// Nothing here is logged.
import AVFoundation
import Capacitor
import Foundation

@objc(SlogaCallAudioPlugin)
public final class SlogaCallAudioPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "SlogaCallAudioPlugin"
    public let jsName = "SlogaCallAudio"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "start", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "stop", returnType: CAPPluginReturnPromise),
    ]

    private static let armLock = NSLock()
    private static var armed = false

    /// Called once by the bridge view controller after the main-frame
    /// bridge guard is in place, before it registers this plugin.
    static func arm() {
        armLock.lock()
        armed = true
        armLock.unlock()
    }

    private static func armedOrReject(_ call: CAPPluginCall) -> Bool {
        armLock.lock()
        let isArmed = armed
        armLock.unlock()
        if !isArmed {
            reject(call, .unavailable)
        }
        return isArmed
    }

    /// The one queue every session change runs on (see the header).
    private static let queue = DispatchQueue(label: "gg.sloga.call-audio", qos: .userInitiated)

    /// True while this plugin holds the session active. Read and written on
    /// `queue` only.
    private static var active = false

    /// The fixed reject codes (see the header). Never an OS message.
    private enum Failure: String {
        case unavailable = "call_audio_unavailable"
        case categoryFailed = "call_audio_category_failed"
        case insufficientPriority = "call_audio_insufficient_priority"
        case activateFailed = "call_audio_activate_failed"
        case deactivateFailed = "call_audio_deactivate_failed"
    }

    private static func reject(_ call: CAPPluginCall, _ failure: Failure) {
        // No `error` argument: Capacitor would forward its description.
        call.reject(failure.rawValue, failure.rawValue)
    }

    @objc func start(_ call: CAPPluginCall) {
        guard Self.armedOrReject(call) else { return }
        Self.queue.async {
            if let failure = Self.activate() {
                Self.reject(call, failure)
            } else {
                call.resolve()
            }
        }
    }

    @objc func stop(_ call: CAPPluginCall) {
        guard Self.armedOrReject(call) else { return }
        Self.queue.async {
            if let failure = Self.deactivate() {
                Self.reject(call, failure)
            } else {
                call.resolve()
            }
        }
    }

    /// Native only (not a plugin method): releases the session after the
    /// page that started it is gone (see the header). Safe from any thread,
    /// including main; returns at once. A no-op if nothing is held.
    static func releaseAfterPageLoss() {
        queue.async {
            _ = deactivate()
        }
    }

    /// Activates the call session; nil on success (or if already active).
    private static func activate() -> Failure? {
        dispatchPrecondition(condition: .onQueue(queue))
        if active {
            return nil
        }
        let session = AVAudioSession.sharedInstance()
        do {
            // `.allowBluetoothHFP` is `.allowBluetooth` (C-W2-5) under the
            // name the iOS 26 SDK gives it: the same option bit (0x4), and
            // the old name is deprecated there. HFP: a headset's mic can be
            // the input; A2DP: a stereo headset can be the output;
            // defaultToSpeaker: the loudspeaker, not the earpiece, when
            // nothing is plugged in.
            try session.setCategory(
                .playAndRecord,
                mode: .voiceChat,
                options: [.allowBluetoothHFP, .allowBluetoothA2DP, .defaultToSpeaker]
            )
        } catch {
            return .categoryFailed
        }
        do {
            try session.setActive(true)
        } catch {
            if (error as NSError).code == AVAudioSession.ErrorCode.insufficientPriority.rawValue {
                return .insufficientPriority
            }
            return .activateFailed
        }
        active = true
        return nil
    }

    /// Releases the session and lets other apps' audio resume; nil on
    /// success (or if not active).
    private static func deactivate() -> Failure? {
        dispatchPrecondition(condition: .onQueue(queue))
        if !active {
            return nil
        }
        do {
            try AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
        } catch {
            // isBusy: audio I/O was still running; the session was
            // deactivated anyway (SDK header), so this plugin no longer
            // holds it. Any other error: still held, a retry may succeed.
            if (error as NSError).code != AVAudioSession.ErrorCode.isBusy.rawValue {
                return .deactivateFailed
            }
        }
        active = false
        return nil
    }
}
