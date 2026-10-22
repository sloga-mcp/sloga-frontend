// BridgeGuardTests: gate G9 (IE plan D5 first bullet, risk 7).
//
// MainFrameBridgeGuard replaces Capacitor's "bridge" script message handler so
// that only the app's main frame can reach a plugin. Nothing in Capacitor tells
// us if a version bump changes how "bridge" is registered (another name, another
// content world, a second registration), so these tests drive real WKWebViews
// and count what reaches the handler:
//   1. the pure `admits` decision, against a matrix and against known-bad
//      decision functions the matrix must reject;
//   2. a standalone WKWebView with a cross-origin iframe, srcdoc, sandboxed and
//      about:blank frames, guarded and unguarded (the unguarded run proves every
//      frame really can post, so the guarded run is not passing vacuously);
//   3. the real app: the guard is installed, the E2ee plugin is registered, a
//      main-frame post is admitted and a same-origin subframe post is dropped.
import Capacitor
import UIKit
import WebKit
import XCTest
@testable import SlogaE2ee

final class BridgeGuardTests: XCTestCase {
    private typealias Origin = MainFrameBridgeGuard.Origin
    private typealias Decision = (Bool, Origin, Origin) -> Bool

    // MARK: - 1. admits

    private struct Row {
        let label: String
        let isMainFrame: Bool
        let origin: Origin
        let expected: Origin
        let admit: Bool
    }

    private static let app = Origin(scheme: "capacitor", host: "localhost", port: 0)
    private static let kelvinHost = Origin(scheme: "capacitor", host: "kelvin.test", port: 0)
    private static let blank = Origin(scheme: "", host: "", port: 0)

    private static let rows: [Row] = [
        Row(label: "main frame, exact origin", isMainFrame: true, origin: app, expected: app, admit: true),
        Row(label: "subframe, exact origin (srcdoc / about:blank inherit it)",
            isMainFrame: false, origin: app, expected: app, admit: false),
        Row(label: "subframe, foreign origin", isMainFrame: false,
            origin: Origin(scheme: "https", host: "www.youtube.com", port: 0), expected: app, admit: false),
        Row(label: "main frame, other scheme", isMainFrame: true,
            origin: Origin(scheme: "https", host: "localhost", port: 0), expected: app, admit: false),
        Row(label: "main frame, scheme with a suffix", isMainFrame: true,
            origin: Origin(scheme: "capacitorx", host: "localhost", port: 0), expected: app, admit: false),
        Row(label: "main frame, scheme prefix only", isMainFrame: true,
            origin: Origin(scheme: "capacito", host: "localhost", port: 0), expected: app, admit: false),
        Row(label: "main frame, other host", isMainFrame: true,
            origin: Origin(scheme: "capacitor", host: "evil.example", port: 0), expected: app, admit: false),
        Row(label: "main frame, host extended by a suffix", isMainFrame: true,
            origin: Origin(scheme: "capacitor", host: "localhost.evil.example", port: 0), expected: app, admit: false),
        Row(label: "main frame, empty host", isMainFrame: true,
            origin: Origin(scheme: "capacitor", host: "", port: 0), expected: app, admit: false),
        Row(label: "main frame, other port", isMainFrame: true,
            origin: Origin(scheme: "capacitor", host: "localhost", port: 8080), expected: app, admit: false),
        Row(label: "main frame, upper-case scheme and host", isMainFrame: true,
            origin: Origin(scheme: "CAPACITOR", host: "LocalHost", port: 0), expected: app, admit: true),
        Row(label: "main frame, upper-case expected", isMainFrame: true, origin: app,
            expected: Origin(scheme: "Capacitor", host: "LOCALHOST", port: 0), admit: true),
        Row(label: "subframe, upper-case origin", isMainFrame: false,
            origin: Origin(scheme: "CAPACITOR", host: "LOCALHOST", port: 0), expected: app, admit: false),
        // U+212A KELVIN SIGN lower-cases to ASCII "k" under full Unicode folding.
        Row(label: "main frame, KELVIN SIGN lookalike host", isMainFrame: true,
            origin: Origin(scheme: "capacitor", host: "\u{212A}elvin.test", port: 0), expected: kelvinHost, admit: false),
        Row(label: "main frame, ASCII K host", isMainFrame: true,
            origin: Origin(scheme: "capacitor", host: "Kelvin.test", port: 0), expected: kelvinHost, admit: true),
        Row(label: "opaque origin against the app origin", isMainFrame: true, origin: blank, expected: app, admit: false),
        Row(label: "empty expected, opaque main frame", isMainFrame: true, origin: blank, expected: blank, admit: false),
        Row(label: "empty expected scheme only", isMainFrame: true,
            origin: Origin(scheme: "", host: "localhost", port: 0),
            expected: Origin(scheme: "", host: "localhost", port: 0), admit: false),
        Row(label: "empty expected host only", isMainFrame: true,
            origin: Origin(scheme: "capacitor", host: "", port: 0),
            expected: Origin(scheme: "capacitor", host: "", port: 0), admit: false),
    ]

    private static func rowsDisagreeing(with decide: Decision) -> [String] {
        rows.filter { decide($0.isMainFrame, $0.origin, $0.expected) != $0.admit }.map { $0.label }
    }

    func testAdmitsMatrix() {
        // The KELVIN row only means something if full Unicode folding really maps it onto ASCII.
        XCTAssertEqual("\u{212A}elvin.test".lowercased(), "kelvin.test")
        for row in Self.rows {
            XCTAssertEqual(
                MainFrameBridgeGuard.admits(isMainFrame: row.isMainFrame, origin: row.origin, expected: row.expected),
                row.admit, row.label)
        }
    }

    /// Failing-first control for the matrix, kept in the suite: each known-bad decision
    /// function must disagree with the matrix somewhere. A matrix that let one of these
    /// through would also let the same regression in the guard through.
    func testAdmitsMatrixRejectsKnownBadDecisions() {
        func fold(_ s: String) -> String {
            String(decoding: s.utf8.map { ($0 >= 0x41 && $0 <= 0x5A) ? $0 | 0x20 : $0 }, as: UTF8.self)
        }
        func sameOrigin(_ o: Origin, _ e: Origin) -> Bool {
            fold(o.scheme) == fold(e.scheme) && fold(o.host) == fold(e.host) && o.port == e.port
        }
        let nonEmpty: (Origin) -> Bool = { !$0.scheme.isEmpty && !$0.host.isEmpty }
        let mutants: [(String, Decision)] = [
            ("always admit", { _, _, _ in true }),
            ("never admit", { _, _, _ in false }),
            ("ignores the frame", { _, o, e in nonEmpty(e) && sameOrigin(o, e) }),
            ("ignores the origin", { main, _, e in main && nonEmpty(e) }),
            ("ignores the port", { main, o, e in
                main && nonEmpty(e) && fold(o.scheme) == fold(e.scheme) && fold(o.host) == fold(e.host) }),
            ("ignores the scheme", { main, o, e in
                main && nonEmpty(e) && fold(o.host) == fold(e.host) && o.port == e.port }),
            ("case-sensitive", { main, o, e in
                main && nonEmpty(e) && o.scheme == e.scheme && o.host == e.host && o.port == e.port }),
            ("Unicode case folding", { main, o, e in
                main && nonEmpty(e) && o.scheme.lowercased() == e.scheme.lowercased()
                    && o.host.lowercased() == e.host.lowercased() && o.port == e.port }),
            ("prefix match", { main, o, e in
                main && nonEmpty(e) && fold(o.scheme).hasPrefix(fold(e.scheme))
                    && fold(o.host).hasPrefix(fold(e.host)) && o.port == e.port }),
            ("no empty-expected guard", { main, o, e in main && sameOrigin(o, e) }),
        ]
        for (name, decide) in mutants {
            XCTAssertFalse(Self.rowsDisagreeing(with: decide).isEmpty, "the matrix does not catch mutant: \(name)")
        }
        XCTAssertEqual(Self.rowsDisagreeing(with: MainFrameBridgeGuard.admits(isMainFrame:origin:expected:)), [])
    }

    // MARK: - 2. standalone WKWebView

    private static let pageScheme = "slogatest"
    private static let evilScheme = "slogaevil"
    private static let pageOrigin = Origin(scheme: pageScheme, host: "app", port: 0)
    private static let reportName = "t4report"
    /// Every posting context in the test page. "reach" is the main frame's script calling
    /// the about:blank child's own `webkit.messageHandlers.bridge` object.
    private static let postingContexts: Set<String> = ["main", "evil", "srcdoc", "sandbox", "blank", "reach"]

    func testStandaloneUnguardedControlEveryFrameReachesTheHandler() throws {
        let outcome = try runStandalone(guardExpecting: nil)
        XCTAssertNil(outcome.admitted)

        // Without the guard every frame's post reaches the handler: this is what makes
        // "inner never called" in the guarded tests mean something.
        let received = Dictionary(outcome.bridge.map { ($0.callbackId ?? "?", $0) }, uniquingKeysWith: { a, _ in a })
        XCTAssertEqual(Set(received.keys), Set(Self.postingContexts.map { "t4-" + $0 }))
        XCTAssertEqual(outcome.bridge.count, Self.postingContexts.count)
        XCTAssertEqual(received["t4-main"]?.isMainFrame, true)
        for name in Self.postingContexts.subtracting(["main"]) {
            XCTAssertEqual(received["t4-" + name]?.isMainFrame, false, "\(name) must post as a subframe")
        }
        // The cross-origin frame really is cross-origin.
        XCTAssertEqual(received["t4-evil"]?.scheme, Self.evilScheme)
        XCTAssertEqual(received["t4-evil"]?.host, "frame")
        // A same-origin frame inherits the app origin, so only the main-frame test stops it.
        XCTAssertEqual(received["t4-srcdoc"]?.scheme, Self.pageScheme)
        XCTAssertEqual(received["t4-srcdoc"]?.host, "app")
        XCTAssertEqual(received["t4-blank"]?.scheme, Self.pageScheme)
    }

    func testStandaloneGuardAdmitsOnlyTheMainFrame() throws {
        let outcome = try runStandalone(guardExpecting: Self.pageOrigin)
        XCTAssertEqual(outcome.bridge.map { $0.callbackId ?? "?" }, ["t4-main"])
        XCTAssertEqual(outcome.bridge.first?.isMainFrame, true)
        XCTAssertEqual(outcome.admitted, 1)
        XCTAssertEqual(outcome.dropped, Self.postingContexts.count - 1)
    }

    func testStandaloneGuardChecksTheMainFrameOrigin() throws {
        let wrong: [(String, Origin)] = [
            ("other host", Origin(scheme: Self.pageScheme, host: "frame", port: 0)),
            ("other scheme", Origin(scheme: Self.evilScheme, host: "app", port: 0)),
            ("other port", Origin(scheme: Self.pageScheme, host: "app", port: 8443)),
        ]
        for (label, expected) in wrong {
            let outcome = try runStandalone(guardExpecting: expected)
            XCTAssertEqual(outcome.bridge.count, 0, label)
            XCTAssertEqual(outcome.admitted, 0, label)
            XCTAssertEqual(outcome.dropped, Self.postingContexts.count, label)
        }
        let upper = try runStandalone(guardExpecting: Origin(scheme: "SlogaTest", host: "APP", port: 0))
        XCTAssertEqual(upper.bridge.map { $0.callbackId ?? "?" }, ["t4-main"])
        XCTAssertEqual(upper.admitted, 1)
        XCTAssertEqual(upper.dropped, Self.postingContexts.count - 1)
    }

    private struct Outcome {
        let bridge: [Received]
        let admitted: Int?
        let dropped: Int?
    }

    /// Loads the test page (main frame on slogatest://app/, a cross-origin iframe on
    /// slogaevil://frame/, plus srcdoc, sandboxed srcdoc and about:blank frames). Every
    /// context posts one Capacitor-shaped message to "bridge" and then a report to an
    /// unguarded handler saying whether the bridge handler was visible and whether the
    /// post returned. `guardExpecting == nil` installs the recorder as "bridge" directly.
    private func runStandalone(guardExpecting expected: Origin?) throws -> Outcome {
        let configuration = WKWebViewConfiguration()
        let server = PageServer(pages: [
            Self.pageScheme: Self.mainPageHTML(),
            Self.evilScheme: Self.evilPageHTML(),
        ])
        configuration.setURLSchemeHandler(server, forURLScheme: Self.pageScheme)
        configuration.setURLSchemeHandler(server, forURLScheme: Self.evilScheme)
        let controller = WKUserContentController()
        configuration.userContentController = controller

        let inner = Recorder()
        let reports = Recorder()
        var bridgeGuard: MainFrameBridgeGuard?
        if let expected = expected {
            let installed = MainFrameBridgeGuard(inner: inner, expected: expected)
            controller.add(installed, name: MainFrameBridgeGuard.handlerName)
            bridgeGuard = installed
        } else {
            controller.add(inner, name: MainFrameBridgeGuard.handlerName)
        }
        controller.add(reports, name: Self.reportName)

        let webView = WKWebView(frame: CGRect(x: 0, y: 0, width: 320, height: 480), configuration: configuration)
        defer {
            webView.stopLoading()
            // The controller holds its handlers strongly; release them with the webview.
            controller.removeAllScriptMessageHandlers()
        }

        let everyone = expectation(description: "every posting context reported")
        var reported = false
        reports.onMessage = { [unowned reports] _ in
            let seen = Set(reports.messages.compactMap { $0.from })
            if !reported && seen.isSuperset(of: Self.postingContexts) {
                reported = true
                everyone.fulfill()
            }
        }
        let url = try XCTUnwrap(URL(string: Self.pageScheme + "://app/"))
        webView.load(URLRequest(url: url))
        wait(for: [everyone], timeout: 20)

        let byContext = Dictionary(reports.messages.compactMap { m in m.from.map { ($0, m) } },
                                   uniquingKeysWith: { a, _ in a })
        for name in Self.postingContexts {
            let report = byContext[name]
            // A frame that could not see the handler, or whose post threw, would make a
            // "nothing reached the handler" result vacuous.
            XCTAssertEqual(report?.body["hasBridge"] as? Bool, true, "\(name) sees webkit.messageHandlers.bridge")
            XCTAssertEqual(report?.postReturned, true,
                           "\(name) postMessage returned (threw: \(report?.body["threw"] ?? "no report"))")
        }
        // The cross-origin iframe's own report really came from the cross-origin frame.
        XCTAssertEqual(byContext["evil"]?.isMainFrame, false)
        XCTAssertEqual(byContext["evil"]?.scheme, Self.evilScheme)
        XCTAssertEqual(byContext["evil"]?.host, "frame")

        // WebKit delivers script messages in order on main, so once this round trip is
        // back, nothing posted earlier can still be in flight.
        let flushed = expectation(description: "flush")
        var flushSeen = false
        reports.onMessage = { message in
            if message.from == "flush" && !flushSeen {
                flushSeen = true
                flushed.fulfill()
            }
        }
        webView.evaluateJavaScript(
            "window.webkit.messageHandlers.\(Self.reportName).postMessage({ from: \"flush\" }); true",
            completionHandler: nil)
        wait(for: [flushed], timeout: 10)
        reports.onMessage = nil

        return Outcome(bridge: inner.messages, admitted: bridgeGuard?.admittedCount, dropped: bridgeGuard?.droppedCount)
    }

    /// The message shape Capacitor's native-bridge.js posts for `E2ee.call({__cmd: "e2ee_status"})`.
    private static func capacitorMessageJS(callbackId: String) -> String {
        "{ type: \"message\", pluginId: \"E2ee\", methodName: \"call\", "
            + "options: { __cmd: \"e2ee_status\" }, callbackId: \"\(callbackId)\" }"
    }

    /// Runs in the posting context itself: its own `window`, its own `webkit`.
    private static func reporterJS(_ name: String) -> String {
        """
        (function () {
          var r = { from: "\(name)", hasBridge: false, threw: "not run" };
          try {
            var h = window.webkit.messageHandlers.bridge;
            r.hasBridge = typeof h.postMessage === "function";
            h.postMessage(\(capacitorMessageJS(callbackId: "t4-" + name)));
            r.threw = false;
          } catch (e) {
            r.threw = String(e);
          }
          window.webkit.messageHandlers.\(reportName).postMessage(r);
        })();
        """
    }

    private static func mainPageHTML() -> String {
        let srcdoc = jsString("<!doctype html><script>" + reporterJS("srcdoc") + "</script>")
        let sandboxed = jsString("<!doctype html><script>" + reporterJS("sandbox") + "</script>")
        let blankDoc = jsString("<script>" + reporterJS("blank") + "</script>")
        return """
        <!doctype html><html><head><meta charset="utf-8"></head><body>
        <iframe id="evil" src="\(evilScheme)://frame/"></iframe>
        <script>
        \(reporterJS("main"))
        (function () {
          function frame(id, attrs) {
            var f = document.createElement("iframe");
            f.id = id;
            Object.keys(attrs).forEach(function (k) { f.setAttribute(k, attrs[k]); });
            document.body.appendChild(f);
            return f;
          }
          frame("srcdoc", { srcdoc: \(srcdoc) });
          frame("sandbox", { sandbox: "allow-scripts", srcdoc: \(sandboxed) });
          var blank = frame("blank", {});
          var d = blank.contentDocument;
          d.open();
          d.write(\(blankDoc));
          d.close();
          var r = { from: "reach", hasBridge: false, threw: "not run" };
          try {
            var h = blank.contentWindow.webkit.messageHandlers.bridge;
            r.hasBridge = typeof h.postMessage === "function";
            h.postMessage(\(capacitorMessageJS(callbackId: "t4-reach")));
            r.threw = false;
          } catch (e) {
            r.threw = String(e);
          }
          window.webkit.messageHandlers.\(reportName).postMessage(r);
        })();
        </script>
        </body></html>
        """
    }

    private static func evilPageHTML() -> String {
        "<!doctype html><html><head><meta charset=\"utf-8\"></head><body><script>"
            + reporterJS("evil") + "</script></body></html>"
    }

    /// A JS string literal. "</" is escaped so the text cannot close the surrounding <script>.
    private static func jsString(_ s: String) -> String {
        guard let data = try? JSONSerialization.data(withJSONObject: [s]),
              let array = String(data: data, encoding: .utf8) else {
            return "\"\""
        }
        return String(array.dropFirst().dropLast()).replacingOccurrences(of: "</", with: "<\\/")
    }

    // MARK: - 3. the real app

    private static let flushName = "t4flush"

    private struct LiveApp {
        let controller: SlogaBridgeViewController
        let webView: WKWebView
        let bridgeGuard: MainFrameBridgeGuard
        let contentController: WKUserContentController
    }

    /// The running app's bridge view controller once its page has loaded.
    private func liveApp() throws -> LiveApp {
        let root = UIApplication.shared.delegate?.window??.rootViewController
        let vc = try XCTUnwrap(root as? SlogaBridgeViewController,
                               "the root view controller is not SlogaBridgeViewController")
        XCTAssertTrue(spin(timeout: 30) { vc.bridge != nil && vc.webView?.url != nil && vc.webView?.isLoading == false },
                      "the app's webview did not finish loading")
        let webView = try XCTUnwrap(vc.webView)
        let bridgeGuard = try XCTUnwrap(vc.bridgeGuard, "bridgeGuard is nil: the guard was not installed")
        let capBridge = try XCTUnwrap(vc.bridge as? CapacitorBridge)
        return LiveApp(controller: vc, webView: webView, bridgeGuard: bridgeGuard,
                       contentController: capBridge.webViewDelegationHandler.contentController)
    }

    func testRealAppInstallsTheGuardAndRegistersE2ee() throws {
        let app = try liveApp()
        let plugin = app.controller.bridge?.plugin(withName: "E2ee")
        XCTAssertNotNil(plugin, "the E2ee plugin is not registered")
        XCTAssertTrue(plugin is E2eePlugin)
    }

    /// What the guard did in one marked window of the live page.
    ///
    /// The live app's main frame posts to "bridge" on its own (Capacitor console
    /// forwarding, plugin calls), and the probe itself provokes some of that, so a bare
    /// "admittedCount did not move" is false on a correct guard. Instead the window is
    /// bracketed by two marks on an unguarded handler; the guard's counters are sampled
    /// at the instant each mark is delivered (WebKit delivers script messages in post
    /// order, on main), and a temporary wrapper counts the main frame's own posts to
    /// "bridge" in the same window. The guard admits only main-frame posts, so
    /// `admitted == mainPosts` exactly unless something else got through.
    private struct Window {
        let admitted: Int
        let dropped: Int
        let mainPosts: Int
        let result: [String: Any]

        var summary: String {
            "admitted +\(admitted), dropped +\(dropped), main-frame posts \(mainPosts) "
                + "\(result["mainKinds"] ?? "none")"
        }
    }

    private func measure(_ app: LiveApp, _ marks: Recorder, body: String) throws -> Window {
        let counters = app.bridgeGuard
        marks.sample = { [counters.admittedCount, counters.droppedCount] }
        defer { marks.sample = nil }
        let before = marks.messages.count
        _ = try roundTrip(app.webView, marks, kickoff: Self.instrumentedJS(body))
        let fresh = marks.messages.dropFirst(before)
        let start = try XCTUnwrap(fresh.first { $0.from == "start" }?.sample, "no start mark")
        let end = try XCTUnwrap(fresh.first { $0.from == "flush" }, "no end mark")
        let endSample = try XCTUnwrap(end.sample)
        XCTAssertEqual(end.body["wrapped"] as? Bool, true,
                       "could not count the main frame's own bridge posts; the accounting below is meaningless")
        return Window(admitted: endSample[0] - start[0], dropped: endSample[1] - start[1],
                      mainPosts: end.body["mainPosts"] as? Int ?? -1, result: end.body)
    }

    /// Positive control for the subframe test: a main-frame post goes through the guard
    /// and is admitted. If a Capacitor bump left the guard installed but no longer the
    /// live "bridge" handler, admittedCount would not move here.
    func testRealAppMainFramePostIsAdmitted() throws {
        let app = try liveApp()
        let marks = Recorder()
        app.contentController.add(marks, name: Self.flushName)
        defer { app.contentController.removeScriptMessageHandler(forName: Self.flushName) }

        // An unknown message type: Capacitor's handler ignores it, no plugin runs.
        let window = try measure(app, marks, body: """
            window.webkit.messageHandlers.bridge.postMessage({ type: "t4-noop" });
            out.threw = false;
            """)
        XCTAssertEqual(window.result["threw"] as? Bool, false, "postMessage threw: \(window.result["threw"] ?? "nil")")
        XCTAssertGreaterThanOrEqual(window.mainPosts, 1, window.summary)
        XCTAssertEqual(window.admitted, window.mainPosts, window.summary)
        XCTAssertEqual(window.dropped, 0, window.summary)
    }

    func testRealAppSubframePostIsDropped() throws {
        let app = try liveApp()
        let marks = Recorder()
        app.contentController.add(marks, name: Self.flushName)
        defer {
            app.contentController.removeScriptMessageHandler(forName: Self.flushName)
            app.webView.evaluateJavaScript(Self.removeProbeJS, completionHandler: nil)
        }

        let window = try measure(app, marks, body: Self.subframeProbeBodyJS())
        XCTAssertEqual(window.result["loaded"] as? Bool, true, "the srcdoc probe frame did not load")
        // Without these the probe never posted and "dropped" would prove nothing.
        XCTAssertEqual(window.result["visible"] as? Bool, true,
                       "the srcdoc frame cannot see webkit.messageHandlers.bridge")
        XCTAssertEqual(window.result["threw"] as? Bool, false, "postMessage threw: \(window.result["threw"] ?? "nil")")
        // The app CSP (script-src 'self', no 'unsafe-inline') is inherited by srcdoc and
        // blocks the frame's own inline script. If a future CSP allows it, that script
        // posts once more and is counted.
        let inlineRan = window.result["ran"] as? Bool ?? false
        XCTAssertEqual(window.dropped, 1 + (inlineRan ? 1 : 0), "the subframe post was not dropped: \(window.summary)")
        XCTAssertEqual(window.admitted, window.mainPosts, "something besides the main frame was admitted: \(window.summary)")

        let removal = try roundTrip(app.webView, marks, kickoff: Self.removeProbeJS + """
            window.webkit.messageHandlers.\(Self.flushName).postMessage(
              { from: "flush", gone: document.getElementById("t4-probe") === null });
            true
            """)
        XCTAssertEqual(removal["gone"] as? Bool, true, "the probe frame was not removed")
    }

    private static let removeProbeJS = """
        (function () { var f = document.getElementById("t4-probe"); if (f) { f.remove(); } })();
        """

    /// Wraps `body` (async JS that fills in `out`) between a "start" and an end mark on the
    /// unguarded t4flush handler, counting the main frame's own posts to "bridge" in between.
    /// The wrapper is an own property on the main frame's handler object and is deleted
    /// once the end mark is posted; frames have their own handler objects and are not counted.
    private static func instrumentedJS(_ body: String) -> String {
        """
        (async function () {
          var out = { from: "flush", wrapped: false, mainPosts: 0, mainKinds: [], threw: "not run" };
          var h0 = window.webkit.messageHandlers.bridge;
          var orig = h0.postMessage;
          h0.postMessage = function (m) {
            out.mainPosts += 1;
            out.mainKinds.push(String(m && m.type) + ":" + String(m && m.pluginId) + "." + String(m && m.methodName));
            return orig.call(h0, m);
          };
          out.wrapped = window.webkit.messageHandlers.bridge.postMessage !== orig;
          window.webkit.messageHandlers.\(flushName).postMessage({ from: "start" });
          try {
        \(body)
          } catch (e) {
            out.threw = String(e);
          }
          window.webkit.messageHandlers.\(flushName).postMessage(out);
          delete h0.postMessage;
        })();
        true
        """
    }

    /// Inserts a hidden srcdoc iframe (same origin as the app) and posts a Capacitor-shaped
    /// `E2ee.call({__cmd: "e2ee_status"})` through the FRAME's own handler object.
    private static func subframeProbeBodyJS() -> String {
        let message = capacitorMessageJS(callbackId: "t4")
        let srcdoc = jsString("<!doctype html><script>window.__t4ran = true; try { "
            + "window.webkit.messageHandlers.bridge.postMessage(\(message)); } catch (e) {}</script>")
        return """
            var old = document.getElementById("t4-probe");
            if (old) { old.remove(); }
            var f = document.createElement("iframe");
            f.id = "t4-probe";
            f.style.display = "none";
            f.setAttribute("srcdoc", \(srcdoc));
            out.loaded = await new Promise(function (resolve) {
              var t = setTimeout(function () { resolve(false); }, 10000);
              f.addEventListener("load", function () { clearTimeout(t); resolve(true); }, { once: true });
              document.body.appendChild(f);
            });
            var w = f.contentWindow;
            out.ran = w.__t4ran === true;
            var h = w.webkit.messageHandlers.bridge;
            out.visible = typeof h.postMessage === "function";
            h.postMessage(\(message));
            out.threw = false;
        """
    }

    /// Runs `kickoff` in the page and waits for its next "flush" message on `recorder`.
    /// Script messages are delivered in order on main, so everything the kickoff posted
    /// before the flush has been handled when this returns.
    private func roundTrip(_ webView: WKWebView, _ recorder: Recorder, kickoff: String) throws -> [String: Any] {
        let done = expectation(description: "flush")
        var seen = false
        recorder.onMessage = { message in
            if message.from == "flush" && !seen {
                seen = true
                done.fulfill()
            }
        }
        defer { recorder.onMessage = nil }
        let before = recorder.messages.count
        webView.evaluateJavaScript(kickoff) { _, error in
            XCTAssertNil(error, "evaluateJavaScript failed: \(String(describing: error))")
        }
        wait(for: [done], timeout: 20)
        let flushed = recorder.messages.dropFirst(before).first { $0.from == "flush" }
        return try XCTUnwrap(flushed, "no flush message").body
    }

    /// Spins the main run loop until `condition` holds, in short steps.
    private func spin(timeout: TimeInterval, until condition: () -> Bool) -> Bool {
        let deadline = Date().addingTimeInterval(timeout)
        while !condition() {
            if Date() >= deadline {
                return false
            }
            RunLoop.current.run(mode: .default, before: Date().addingTimeInterval(0.05))
        }
        return true
    }
}

// MARK: - helpers

/// One script message, as the test sees it.
private struct Received {
    let isMainFrame: Bool
    let scheme: String
    let host: String
    let port: Int
    let body: [String: Any]
    /// The recorder's `sample` taken the moment this message was delivered.
    var sample: [Int]?

    init(_ message: WKScriptMessage) {
        let origin = message.frameInfo.securityOrigin
        isMainFrame = message.frameInfo.isMainFrame
        scheme = origin.protocol
        host = origin.host
        port = origin.port
        body = message.body as? [String: Any] ?? [:]
    }

    var from: String? { body["from"] as? String }
    var callbackId: String? { body["callbackId"] as? String }
    /// The page sets `threw` to false after postMessage returns, or to the error text.
    var postReturned: Bool { !(body["threw"] is String) && (body["threw"] as? Bool) == false }
}

/// Records every message it receives (main thread only, like every WebKit delivery).
private final class Recorder: NSObject, WKScriptMessageHandler {
    private(set) var messages: [Received] = []
    var onMessage: ((Received) -> Void)?
    var sample: (() -> [Int])?

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        var received = Received(message)
        received.sample = sample?()
        messages.append(received)
        onMessage?(received)
    }
}

/// Serves one fixed HTML page per custom scheme.
private final class PageServer: NSObject, WKURLSchemeHandler {
    private let pages: [String: String]

    init(pages: [String: String]) {
        self.pages = pages
        super.init()
    }

    func webView(_ webView: WKWebView, start urlSchemeTask: WKURLSchemeTask) {
        guard let url = urlSchemeTask.request.url,
              let scheme = url.scheme?.lowercased(),
              let html = pages[scheme] else {
            urlSchemeTask.didFailWithError(URLError(.fileDoesNotExist))
            return
        }
        let data = Data(html.utf8)
        urlSchemeTask.didReceive(URLResponse(url: url, mimeType: "text/html",
                                             expectedContentLength: data.count, textEncodingName: "utf-8"))
        urlSchemeTask.didReceive(data)
        urlSchemeTask.didFinish()
    }

    func webView(_ webView: WKWebView, stop urlSchemeTask: WKURLSchemeTask) {}
}
