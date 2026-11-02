// SlogaBridgeViewController.swift: the Capacitor bridge view controller the
// storyboard uses (IE plan D1 "Teardown", D5 "Packaging" / "Engine
// lifecycle", D6 "Serving").
//
// What it adds to CAPBridgeViewController:
//   - the `e2ee-att://` scheme handler that serves decrypted attachments
//     from memory (a same-origin path is not possible on iOS: `loadView` is
//     final, and WKWebView refuses handlers for http/https);
//   - the main-frame bridge guard, and the E2ee and SlogaCallAudio plugins
//     ONLY when the guard is in place;
//   - the `window.__slogaIosCaps` capability object (call E2EE phase 2, C4),
//     defined by a document-start user script in the main frame;
//   - teardown of any open consent dialog, save folder picker and
//     not-yet-minting recovery sheet, and release of a call's audio
//     session, whenever the main frame starts loading a new page;
//   - backup exclusion of `Library/WebKit`, once per process.
//
// It never constructs the engine and never calls into it: the engine is
// built lazily by the first command the webview sends, so a user who never
// enabled E2EE never opens a store or touches the keychain at launch.
import Capacitor
import Foundation
import UIKit
import WebKit

@objc(SlogaBridgeViewController)
open class SlogaBridgeViewController: CAPBridgeViewController {
    /// The installed main-frame guard; nil = not installed, and then the E2ee plugin is NOT
    /// registered (fail closed: the frontend sees no plugin and stays web-mode).
    private(set) var bridgeGuard: MainFrameBridgeGuard?

    /// Watches `webView.isLoading`. Held for the life of the controller; the
    /// observation ends when this is released.
    private var loadingObservation: NSKeyValueObservation?

    /// Runs the WebKit backup exclusion the first time it is read, and never
    /// again in this process (a static `let` initializer runs exactly once).
    /// The file work happens on a thread of its own so it never delays the
    /// first paint.
    private static let excludeWebKitFromBackupOnce: Void = {
        runOnDedicatedThread(name: "gg.sloga.e2ee.webkit-backup-exclusion") {
            E2eeStore.excludeWebKitFromBackup()
        }
    }()

    open override func webViewConfiguration(for instanceConfiguration: InstanceConfiguration) -> WKWebViewConfiguration {
        let configuration = super.webViewConfiguration(for: instanceConfiguration)
        // setURLSchemeHandler raises an Objective-C exception (a crash) for a
        // scheme WebKit handles itself. "e2ee-att" is not one, but if that
        // ever changed, skipping the handler only means attachments do not
        // render; nothing is served from anywhere else.
        if !WKWebView.handlesURLScheme(AttachmentSchemeHandler.scheme) {
            configuration.setURLSchemeHandler(AttachmentSchemeHandler(), forURLScheme: AttachmentSchemeHandler.scheme)
        }
        return configuration
    }

    /// The Info.plist key that says whether this build carries the call
    /// E2EE surface. Info.plist sets it from the SLOGA_MEDIA_E2EE build
    /// setting; only the exact string "YES" turns it on, and an absent,
    /// empty or other value is false.
    static let mediaE2EEInfoKey = "SlogaMediaE2EE"

    /// The whole capability script. A fixed string: the one interpolation is
    /// the literal `true` or `false` chosen here, never a value read from
    /// anywhere else, so nothing outside this file can put code into it.
    static func capsScriptSource(mediaE2EE: Bool) -> String {
        let flag = mediaE2EE ? "true" : "false"
        return "Object.defineProperty(window,\"__slogaIosCaps\",{value:Object.freeze({mediaE2EE:\(flag)}),writable:false,configurable:false,enumerable:false});"
    }

    open override func capacitorDidLoad() {
        super.capacitorDidLoad()

        // The capability object the frontend's media E2EE predicate reads
        // (C4). A user script, not a plugin constant or method: the predicate
        // is synchronous, and every plugin call is an async round trip, so
        // the answer has to be on `window` before the bundle's first script
        // runs; .atDocumentStart guarantees that for every document,
        // reloads included. Frozen and non-configurable, so nothing in the
        // page can turn it on, off or into something else afterwards.
        // Main frame only: the capability belongs to the app's page; a
        // third-party embed frame has no use for it and gets nothing.
        // Not under `slogaShell`: that name tells the frontend it is in a
        // desktop shell and selects the desktop's native paths.
        // Added here and not in webViewConfiguration(for:): Capacitor 8.4.3
        // replaces that configuration's userContentController with its
        // delegation handler's right after the override returns
        // (CAPBridgeViewController.swift:296-298), so a script added there
        // would be dropped silently. This is the controller the web view
        // uses and where Capacitor adds its own document-start scripts
        // (CapacitorBridge.swift:248-252), and capacitorDidLoad runs before
        // the first load (loadView, then viewDidLoad's loadWebView).
        // Not tied to the guard: it states what the build carries; without
        // the guard the E2ee plugin is absent and the frontend has no native
        // call E2EE to use whatever this says.
        if let capBridge = bridge as? CapacitorBridge {
            let mediaE2EE = (Bundle.main.object(forInfoDictionaryKey: Self.mediaE2EEInfoKey) as? String) == "YES"
            let script = WKUserScript(
                source: Self.capsScriptSource(mediaE2EE: mediaE2EE),
                injectionTime: .atDocumentStart,
                forMainFrameOnly: true
            )
            capBridge.webViewDelegationHandler.contentController.addUserScript(script)
        }

        // The guard must be in place before the plugins exist: without it a
        // third-party embed frame could post E2ee commands (enable, wipe,
        // backup) through Capacitor's bridge handler, or take the app's audio
        // session and keep the app alive in the background. No guard, no
        // plugins; the frontend then sees no native E2ee and stays in web
        // mode.
        if let bridge = bridge {
            bridgeGuard = MainFrameBridgeGuard.install(on: bridge)
            if bridgeGuard != nil {
                // Arm first: an instance Capacitor might create by class name
                // stays inert unless the guard got this far (E2eePlugin.arm,
                // SlogaCallAudioPlugin.arm).
                E2eePlugin.arm()
                SlogaCallAudioPlugin.arm()
                let e2ee = E2eePlugin()
                bridge.registerPluginInstance(e2ee)
                // The key push goes to THIS instance only, never to one Capacitor
                // creates by class name later (KeysChangedRelay holds it weakly).
                KeysChangedRelay.attach(e2ee)
                bridge.registerPluginInstance(SlogaCallAudioPlugin())
            }
        }

        // A main-frame load (first load, reload, a navigation away, and the
        // reload Capacitor issues after the web content process dies) means
        // the page that asked for an open dialog or recovery sheet is gone.
        // Decline and dismiss them, so a tap can never commit a wipe,
        // downgrade, verify or save for a caller that no longer exists.
        // A recovery sheet that has started minting or restoring is the one
        // exception and stays up (RecoverySheet.teardownForNavigation): core
        // holds the minted key until the sheet's close takes it, so the code
        // must still be shown and the bundle couriered when the sheet closes
        // (F3), or the user would hold a code whose backup never reaches the
        // server.
        // The page that started a call's audio session is gone too, and can
        // no longer stop it; left held, it would keep the app alive in the
        // background (Guideline 2.5.4), so release it. A web content process
        // crash comes through here as well: Capacitor's delegation handler,
        // which is the web view's navigation delegate and is not replaced
        // here, answers it by reloading (WebViewDelegationHandler.swift:
        // 164-168), and that reload is a main-frame load.
        // Acting on every notification whose new value is true (not only a
        // false-to-true change) errs toward declining and releasing, which is
        // the safe side. All four calls are safe from any thread and never
        // wait on main.
        loadingObservation = webView?.observe(\.isLoading, options: [.new]) { _, change in
            guard change.newValue == true else {
                return
            }
            NativeConfirmPresenter.shared.declineAll()
            RecoverySheet.teardownForNavigation()
            AttachmentTransfer.teardownForNavigation()
            SlogaCallAudioPlugin.releaseAfterPageLoss()
        }

        // IndexedDB drafts and the outbox can hold E2EE plaintext; an iCloud or
        // Finder backup must not carry them off the device (D4).
        _ = Self.excludeWebKitFromBackupOnce

        // WebKit creates Library/WebKit lazily, so on the very first launch it
        // may not exist yet when the line above runs. Backups happen while the
        // app is in the background, so set the flag again every time it goes
        // there (cheap, idempotent).
        backgroundObserver = NotificationCenter.default.addObserver(
            forName: UIApplication.didEnterBackgroundNotification, object: nil, queue: nil
        ) { _ in
            runOnDedicatedThread(name: "gg.sloga.e2ee.webkit-backup-exclusion") {
                E2eeStore.excludeWebKitFromBackup()
            }
        }
    }

    private var backgroundObserver: NSObjectProtocol?

    deinit {
        if let observer = backgroundObserver {
            NotificationCenter.default.removeObserver(observer)
        }
    }
}
