// MainFrameBridgeGuard: main-frame-only Capacitor bridge (IE plan D5, audit MAJOR 2).
//
// Why this exists: Capacitor 8.4.3's WebViewDelegationHandler.userContentController(_:didReceive:)
// (WebViewDelegationHandler.swift:192-230) hands every "bridge" message to bridge.handleJSCall with no
// frame check. WKWebView exposes window.webkit.messageHandlers to every frame, including cross-origin
// iframes, and the app's CSP allows third-party embeds (YouTube, Twitch, Spotify, ...). Without this
// guard an embed could post straight to the E2ee plugin: provision the store, pop native wipe/verify/
// downgrade dialogs over a video, or start a backup. Results go back to the main frame only, so the risk
// is side effects, not reads; it is still unacceptable. The guard covers every plugin, not just E2ee.
//
// Why here and not a pnpm patch of @capacitor/ios: the iOS app links Capacitor as the PREBUILT
// Capacitor.xcframework from capacitor-swift-pm (CapApp-SPM's dependency). The Swift sources under
// node_modules/@capacitor/ios are never compiled into the app, so a patch there would ship nothing.
// App code can still swap the script message handler, because WebViewDelegationHandler.contentController
// is public (WebViewDelegationHandler.swift:9) and is the controller the webview uses
// (CAPBridgeViewController.swift:298).
//
// Risk 7 (a Capacitor bump changing how "bridge" is registered: a new name, another content world, a
// second registration, a re-add on reload) is NOT detected by this file. The G9 XCTest pins it by posting
// from a subframe and from the main frame and checking the counters below. Rerun it on every bump.
import Capacitor
import Foundation
import WebKit

final class MainFrameBridgeGuard: NSObject, WKScriptMessageHandler {
    static let handlerName = "bridge"

    struct Origin: Equatable {
        let scheme: String
        let host: String
        let port: Int
    }

    // Strong, like the WKUserContentController's own strong hold on Capacitor's handler that this
    // replaces. The cycle (controller -> guard -> handler -> controller) is the one Capacitor already
    // had; CapacitorBridge.deinit breaks it with cleanUp(), which removes "bridge" by name and so
    // removes this guard (CapacitorBridge.swift:234-236, WebViewDelegationHandler.swift:25-27).
    private let inner: WKScriptMessageHandler
    private let expected: Origin
    private var admitted = 0
    private var dropped = 0

    init(inner: WKScriptMessageHandler, expected: Origin) {
        self.inner = inner
        self.expected = expected
        super.init()
    }

    /// Pure decision: main frame AND origin == expected (scheme/host case-insensitive, port exact).
    static func admits(isMainFrame: Bool, origin: Origin, expected: Origin) -> Bool {
        // Same-origin iframes (about:blank, srcdoc) inherit the app origin, so the origin test alone
        // would admit them. The main-frame test alone would admit a main frame that navigated to an
        // allowNavigation host. Both are required.
        guard isMainFrame else { return false }
        // An opaque origin (sandboxed frame, data: URL) reports empty strings. A blank expected origin
        // must never turn into "matches anything opaque".
        guard !expected.scheme.isEmpty, !expected.host.isEmpty else { return false }
        return asciiCaseInsensitiveEqual(origin.scheme, expected.scheme)
            && asciiCaseInsensitiveEqual(origin.host, expected.host)
            && origin.port == expected.port
    }

    /// Replace Capacitor's "bridge" script message handler on `bridge`'s content controller with
    /// a guard wrapping Capacitor's WebViewDelegationHandler. nil, and nothing changed, when the
    /// bridge is not a CapacitorBridge or its local URL has no scheme/host. Main thread.
    static func install(on bridge: CAPBridgeProtocol) -> MainFrameBridgeGuard? {
        // WKUserContentController is not thread-safe. Off main, refuse rather than crash: the caller
        // then skips registering the E2ee plugin (fail closed).
        guard Thread.isMainThread else { return nil }
        guard let capBridge = bridge as? CapacitorBridge else { return nil }

        // The app is served from config.localURL (capacitor://localhost here). Sloga sets no server.url,
        // so serverURL == localURL (CAPInstanceConfiguration.m:45-51) and that is the main frame's
        // origin. A dev live-reload server.url would make the guard drop every call: fail closed.
        let url = capBridge.config.localURL
        guard let scheme = url.scheme, !scheme.isEmpty,
              let host = url.host, !host.isEmpty else { return nil }
        // WKSecurityOrigin reports 0 for the scheme's default port, and localURL carries no port.
        let expected = Origin(scheme: scheme, host: host, port: url.port ?? 0)

        let handler = capBridge.webViewDelegationHandler
        let controller = handler.contentController
        let wrapped = MainFrameBridgeGuard(inner: handler, expected: expected)

        // Remove first: add(_:name:) throws an ObjC exception if the name is taken. Both calls use the
        // page content world, the same one Capacitor registered in (WebViewDelegationHandler.swift:22).
        //
        // Nothing in Capacitor 8.4.3 adds "bridge" back after this point (checked against the 8.4.3
        // sources, Capacitor/ and CapacitorCordova/, and @capacitor/push-notifications 8.1.3):
        // - the ONLY add is WebViewDelegationHandler.init (WebViewDelegationHandler.swift:22), run once
        //   in CAPBridgeViewController.loadView (CAPBridgeViewController.swift:44), before
        //   capacitorDidLoad (:53);
        // - cleanUp() only removes (WebViewDelegationHandler.swift:25-27; called from
        //   CapacitorBridge.deinit, CapacitorBridge.swift:236);
        // - reset() clears stored calls and listeners only (CapacitorBridge.swift:298-301), whether from
        //   didStartProvisionalNavigation (WebViewDelegationHandler.swift:45-48) or a web content process
        //   crash, whose reload reuses the same controller (WebViewDelegationHandler.swift:164-168);
        // - plugin registration and every JS export only add user scripts (CapacitorBridge.swift:367,
        //   :375; JSExport.swift:21, :108, :213).
        controller.removeScriptMessageHandler(forName: handlerName)
        controller.add(wrapped, name: handlerName)
        return wrapped
    }

    /// Main thread. Counters for tests.
    var admittedCount: Int { admitted }
    var droppedCount: Int { dropped }

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        // WebKit delivers script messages on main. If that ever changes, drop: the counters and the
        // inner handler both assume main.
        guard Thread.isMainThread else { return }

        let frame = message.frameInfo
        let securityOrigin = frame.securityOrigin
        let origin = Origin(scheme: securityOrigin.protocol, host: securityOrigin.host, port: securityOrigin.port)
        let ok = message.name == Self.handlerName
            && Self.admits(isMainFrame: frame.isMainFrame, origin: origin, expected: expected)

        guard ok else {
            // Silent: this handler type has no reply channel, and the body and the frame's origin are
            // attacker-chosen, so nothing about the message is logged.
            dropped &+= 1
            return
        }
        admitted &+= 1
        inner.userContentController(userContentController, didReceive: message)
    }
}

// ASCII-only folding. Origins arrive as ASCII (hosts are punycoded), and full Unicode case mapping
// would let lookalikes such as U+212A KELVIN SIGN fold onto an ASCII letter.
private func asciiCaseInsensitiveEqual(_ a: String, _ b: String) -> Bool {
    let x = Array(a.utf8)
    let y = Array(b.utf8)
    guard x.count == y.count else { return false }
    for i in 0..<x.count where asciiLower(x[i]) != asciiLower(y[i]) {
        return false
    }
    return true
}

private func asciiLower(_ c: UInt8) -> UInt8 {
    (c >= 0x41 && c <= 0x5A) ? c | 0x20 : c
}
