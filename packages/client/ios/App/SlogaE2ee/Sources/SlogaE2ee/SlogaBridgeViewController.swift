// SlogaBridgeViewController.swift: the Capacitor bridge view controller the
// storyboard uses (IE plan D1 "Teardown", D5 "Packaging" / "Engine
// lifecycle", D6 "Serving").
//
// What it adds to CAPBridgeViewController:
//   - the `e2ee-att://` scheme handler that serves decrypted attachments
//     from memory (a same-origin path is not possible on iOS: `loadView` is
//     final, and WKWebView refuses handlers for http/https);
//   - the main-frame bridge guard, and the E2ee plugin ONLY when the guard
//     is in place;
//   - teardown of any open consent dialog or recovery sheet whenever the
//     main frame starts loading a new page;
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

    open override func capacitorDidLoad() {
        super.capacitorDidLoad()

        // The guard must be in place before the plugin exists: without it a
        // third-party embed frame could post E2ee commands (enable, wipe,
        // backup) through Capacitor's bridge handler. No guard, no plugin;
        // the frontend then sees no native E2ee and stays in web mode.
        if let bridge = bridge {
            bridgeGuard = MainFrameBridgeGuard.install(on: bridge)
            if bridgeGuard != nil {
                // Arm first: an instance Capacitor might create by class name
                // stays inert unless the guard got this far (E2eePlugin.arm).
                E2eePlugin.arm()
                bridge.registerPluginInstance(E2eePlugin())
            }
        }

        // A main-frame load (first load, reload, a navigation away, and the
        // reload Capacitor issues after the web content process dies) means
        // the page that asked for an open dialog or recovery sheet is gone.
        // Decline and dismiss them, so a tap can never commit a wipe,
        // downgrade, verify or backup for a caller that no longer exists.
        // Acting on every notification whose new value is true (not only a
        // false-to-true change) errs toward declining, which is the safe side.
        // Both calls are safe from any thread and never wait on main.
        loadingObservation = webView?.observe(\.isLoading, options: [.new]) { _, change in
            guard change.newValue == true else {
                return
            }
            NativeConfirmPresenter.shared.declineAll()
            RecoverySheet.teardown()
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
