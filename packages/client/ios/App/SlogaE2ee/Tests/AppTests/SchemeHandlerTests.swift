// SchemeHandlerTests.swift: gate G9, the `e2ee-att://` scheme handler (IE
// plan D6 "URL shape", "Handler behavior"). The handler is driven with an
// injected decrypt and a fake WKURLSchemeTask, so no engine or store is
// touched and every answer can be read back exactly.
import AcutestE2eeBindings
import WebKit
import XCTest
@testable import SlogaE2ee

private let ulid = "01ARZ3NDEKTSV4RRFFQ69G5FAV"
private let base = "e2ee-att://att/"

/// Where a real `<img>`/`<video>` subresource load comes from: the app's
/// own document, never the attachment itself.
private let appDocument = URL(string: "capacitor://localhost/")

/// 100 distinct bytes (7 is coprime with 256), so an off-by-one slice can
/// never compare equal to the expected one.
private let fixture = Data((0..<100).map { UInt8(($0 * 7 + 3) & 0xFF) })

private struct ProbeError: Error {}

/// The injected decrypt. Records every call, how many run at once and
/// whether any ran on main; optionally blocks on a gate the test releases.
private final class DecryptProbe: @unchecked Sendable {
    private let lock = NSLock()
    private let content: AttachmentContent?
    private let gate: DispatchSemaphore?
    private var recorded: [String] = []
    private var active = 0
    private var peak = 0
    private var sawMain = false

    /// Signalled once per decrypt, on entry.
    let entered = DispatchSemaphore(value: 0)
    /// Signalled once per decrypt, as it returns or throws.
    let returned = DispatchSemaphore(value: 0)

    /// `content == nil` = every decrypt throws.
    init(content: AttachmentContent?, gated: Bool = false) {
        self.content = content
        gate = gated ? DispatchSemaphore(value: 0) : nil
    }

    func decrypt(_ messageId: String, _ idx: UInt32) throws -> AttachmentContent {
        let onMain = Thread.isMainThread
        XCTAssertFalse(onMain, "the injected decrypt ran on the main thread")
        lock.lock()
        recorded.append("\(messageId)/\(idx)")
        active += 1
        peak = max(peak, active)
        sawMain = sawMain || onMain
        lock.unlock()
        entered.signal()
        defer {
            lock.lock()
            active -= 1
            lock.unlock()
            returned.signal()
        }
        if let gate = gate {
            // Bounded, so a failing test cannot wedge the process-wide
            // decrypt pool for the tests after it.
            _ = gate.wait(timeout: .now() + 20)
        }
        guard let content = content else {
            throw ProbeError()
        }
        return content
    }

    func release(_ count: Int) {
        for _ in 0..<count {
            gate?.signal()
        }
    }

    private func locked<T>(_ read: () -> T) -> T {
        lock.lock()
        defer { lock.unlock() }
        return read()
    }

    var calls: [String] { locked { recorded } }
    var activeNow: Int { locked { active } }
    var peakActive: Int { locked { peak } }
    var ranOnMain: Bool { locked { sawMain } }
}

/// Records every callback the handler makes, in order.
private final class FakeSchemeTask: NSObject, WKURLSchemeTask {
    enum Event: Equatable {
        case response, data, finish, fail
    }

    let request: URLRequest
    /// Fulfilled by the terminal callback (finish or fail). Inverted for a
    /// task that must get no answer at all.
    let done: XCTestExpectation
    /// Runs inside `didReceive(response)`, before it returns, so a test can
    /// stop the task between two callbacks.
    var onResponse: (() -> Void)?

    private(set) var events: [Event] = []
    private(set) var response: HTTPURLResponse?
    private(set) var body = Data()

    init(request: URLRequest, done: XCTestExpectation) {
        self.request = request
        self.done = done
        super.init()
    }

    func didReceive(_ response: URLResponse) {
        events.append(.response)
        self.response = response as? HTTPURLResponse
        onResponse?()
    }

    func didReceive(_ data: Data) {
        events.append(.data)
        body.append(data)
    }

    func didFinish() {
        events.append(.finish)
        done.fulfill()
    }

    func didFailWithError(_ error: Error) {
        events.append(.fail)
        done.fulfill()
    }
}

private func attachmentURL(_ idx: UInt32) throws -> URL {
    try XCTUnwrap(URL(string: base + ulid + "/\(idx)"))
}

private func subresource(_ url: URL, method: String = "GET", range: String? = nil) -> URLRequest {
    var request = URLRequest(url: url)
    request.httpMethod = method
    request.mainDocumentURL = appDocument
    if let range = range {
        request.setValue(range, forHTTPHeaderField: "Range")
    }
    return request
}

private func header(_ task: FakeSchemeTask, _ name: String) -> String? {
    task.response?.value(forHTTPHeaderField: name)
}

private func headerMap(_ task: FakeSchemeTask) -> [String: String] {
    (task.response?.allHeaderFields as? [String: String]) ?? [:]
}

private func replacing(_ s: String, at offset: Int, with c: Character) -> String {
    var chars = Array(s)
    chars[offset] = c
    return String(chars)
}

final class SchemeHandlerTests: XCTestCase {
    // MARK: - Helpers

    /// Starts a load that must be answered; wait on `task.done`.
    @MainActor
    private func begin(
        _ handler: AttachmentSchemeHandler,
        _ webView: WKWebView,
        _ request: URLRequest,
        _ label: String
    ) -> FakeSchemeTask {
        let task = FakeSchemeTask(request: request, done: expectation(description: label))
        handler.webView(webView, start: task)
        return task
    }

    /// A task that must never be answered: its `done` is inverted.
    @MainActor
    private func silentTask(_ request: URLRequest, _ label: String) -> FakeSchemeTask {
        let done = expectation(description: label)
        done.isInverted = true
        return FakeSchemeTask(request: request, done: done)
    }

    /// Starts a load and waits for its terminal callback.
    @MainActor
    private func load(
        _ handler: AttachmentSchemeHandler,
        _ webView: WKWebView,
        _ request: URLRequest,
        _ label: String
    ) -> FakeSchemeTask {
        let task = begin(handler, webView, request, label)
        wait(for: [task.done], timeout: 10)
        return task
    }

    private func assertHardened(
        _ response: HTTPURLResponse?,
        _ label: String,
        file: StaticString = #filePath,
        line: UInt = #line
    ) {
        guard let response = response else {
            XCTFail("\(label): no HTTPURLResponse", file: file, line: line)
            return
        }
        XCTAssertEqual(
            response.value(forHTTPHeaderField: "Cache-Control"), "no-store",
            "\(label): Cache-Control", file: file, line: line)
        XCTAssertEqual(
            response.value(forHTTPHeaderField: "X-Content-Type-Options"), "nosniff",
            "\(label): X-Content-Type-Options", file: file, line: line)
        XCTAssertEqual(
            response.value(forHTTPHeaderField: "Content-Security-Policy"), "sandbox",
            "\(label): Content-Security-Policy", file: file, line: line)
        // No CORS grant: a webview `fetch` of the scheme must stay blocked.
        let names = response.allHeaderFields.keys.compactMap { ($0 as? String)?.lowercased() }
        XCTAssertFalse(
            names.contains("access-control-allow-origin"),
            "\(label): Access-Control-Allow-Origin present", file: file, line: line)
    }

    private func assertNotFound(
        _ task: FakeSchemeTask,
        _ label: String,
        file: StaticString = #filePath,
        line: UInt = #line
    ) {
        XCTAssertEqual(task.events, [.response, .finish], "\(label): callbacks", file: file, line: line)
        XCTAssertEqual(task.response?.statusCode, 404, "\(label): status", file: file, line: line)
        XCTAssertEqual(header(task, "Content-Length"), "0", "\(label): Content-Length", file: file, line: line)
        XCTAssertNil(header(task, "Content-Type"), "\(label): Content-Type", file: file, line: line)
        XCTAssertNil(header(task, "Content-Range"), "\(label): Content-Range", file: file, line: line)
        XCTAssertTrue(task.body.isEmpty, "\(label): body", file: file, line: line)
        assertHardened(task.response, label, file: file, line: line)
    }

    /// A 200 (`contentRange == nil`) or 206 carrying exactly `body`.
    private func assertServed(
        _ task: FakeSchemeTask,
        status: Int,
        mime: String,
        body: Data,
        contentRange: String?,
        _ label: String,
        file: StaticString = #filePath,
        line: UInt = #line
    ) {
        let events: [FakeSchemeTask.Event] = body.isEmpty ? [.response, .finish] : [.response, .data, .finish]
        XCTAssertEqual(task.events, events, "\(label): callbacks", file: file, line: line)
        XCTAssertEqual(task.response?.statusCode, status, "\(label): status", file: file, line: line)
        XCTAssertEqual(header(task, "Content-Type"), mime, "\(label): Content-Type", file: file, line: line)
        XCTAssertEqual(
            header(task, "Content-Length"), String(body.count), "\(label): Content-Length", file: file, line: line)
        XCTAssertEqual(header(task, "Accept-Ranges"), "bytes", "\(label): Accept-Ranges", file: file, line: line)
        XCTAssertEqual(header(task, "Content-Range"), contentRange, "\(label): Content-Range", file: file, line: line)
        XCTAssertEqual(task.body, body, "\(label): body", file: file, line: line)
        assertHardened(task.response, label, file: file, line: line)
    }

    private func assertUnsatisfiable(
        _ task: FakeSchemeTask,
        length: Int,
        _ label: String,
        file: StaticString = #filePath,
        line: UInt = #line
    ) {
        XCTAssertEqual(task.events, [.response, .finish], "\(label): callbacks", file: file, line: line)
        XCTAssertEqual(task.response?.statusCode, 416, "\(label): status", file: file, line: line)
        XCTAssertEqual(
            header(task, "Content-Range"), "bytes */\(length)", "\(label): Content-Range", file: file, line: line)
        XCTAssertEqual(header(task, "Content-Length"), "0", "\(label): Content-Length", file: file, line: line)
        XCTAssertTrue(task.body.isEmpty, "\(label): body", file: file, line: line)
        assertHardened(task.response, label, file: file, line: line)
    }

    // MARK: - URL parsing

    func testParseAcceptsCanonicalUrls() {
        // Two ids that between them use every Crockford symbol, plus the
        // bounds of the first character and of the u32 index.
        let everySymbolA = "0123456789ABCDEFGHJKMNPQRS"
        let everySymbolB = "7TVWXYZ" + String(repeating: "0", count: 19)
        let lowest = String(repeating: "0", count: 26)
        let highest = "7" + String(repeating: "Z", count: 25)
        let rows: [(url: String, id: String, idx: UInt32)] = [
            (base + ulid + "/0", ulid, 0),
            (base + ulid + "/7", ulid, 7),
            (base + ulid + "/42", ulid, 42),
            (base + ulid + "/4294967295", ulid, UInt32.max),
            (base + everySymbolA + "/1", everySymbolA, 1),
            (base + everySymbolB + "/2", everySymbolB, 2),
            (base + lowest + "/0", lowest, 0),
            (base + highest + "/9", highest, 9),
        ]
        for row in rows {
            guard let url = URL(string: row.url) else {
                XCTFail("not a URL, so the row tests nothing: \(row.url)")
                continue
            }
            guard let parsed = AttachmentSchemeHandler.parse(url) else {
                XCTFail("canonical URL rejected: \(row.url)")
                continue
            }
            XCTAssertEqual(parsed.messageId, row.id, row.url)
            XCTAssertEqual(parsed.idx, row.idx, row.url)
        }
    }

    /// Every row is one mutation of the canonical URL, so each one fails
    /// for the reason its label gives and no other.
    func testParseRejectsEverythingElse() {
        let canonical = base + ulid + "/0"
        XCTAssertNotNil(URL(string: canonical).flatMap(AttachmentSchemeHandler.parse), "canonical")
        let rows: [(why: String, url: String)] = [
            // scheme, host, authority
            ("wrong scheme", "https://att/" + ulid + "/0"),
            ("wrong host", "e2ee-att://evil/" + ulid + "/0"),
            ("host with a suffix", "e2ee-att://att.evil/" + ulid + "/0"),
            ("missing host", "e2ee-att:///" + ulid + "/0"),
            ("no authority", "e2ee-att:att/" + ulid + "/0"),
            ("user", "e2ee-att://user@att/" + ulid + "/0"),
            ("user and password", "e2ee-att://user:pw@att/" + ulid + "/0"),
            ("port", "e2ee-att://att:443/" + ulid + "/0"),
            ("query", canonical + "?x=1"),
            ("fragment", canonical + "#x"),
            // segments
            ("no path", "e2ee-att://att"),
            ("root path only", "e2ee-att://att/"),
            ("missing idx segment", base + ulid),
            ("empty idx", base + ulid + "/"),
            ("empty id", base + "/0"),
            ("extra trailing segment", canonical + "/1"),
            ("trailing slash", canonical + "/"),
            ("extra leading segment", base + "x/" + ulid + "/0"),
            ("empty leading segment", "e2ee-att://att//" + ulid + "/0"),
            ("dot segment", base + "./" + ulid + "/0"),
            // the id
            ("lowercase id", base + ulid.lowercased() + "/0"),
            ("one lowercase symbol", base + replacing(ulid, at: 25, with: "v") + "/0"),
            ("25-char id", base + String(ulid.dropLast()) + "/0"),
            ("27-char id", base + ulid + "0/0"),
            ("first char 8", base + replacing(ulid, at: 0, with: "8") + "/0"),
            ("first char 9", base + replacing(ulid, at: 0, with: "9") + "/0"),
            ("first char a letter", base + replacing(ulid, at: 0, with: "Z") + "/0"),
            ("contains I", base + replacing(ulid, at: 5, with: "I") + "/0"),
            ("contains L", base + replacing(ulid, at: 5, with: "L") + "/0"),
            ("contains O", base + replacing(ulid, at: 5, with: "O") + "/0"),
            ("contains U", base + replacing(ulid, at: 5, with: "U") + "/0"),
            ("contains a dash", base + replacing(ulid, at: 25, with: "-") + "/0"),
            // the index
            ("idx with plus sign", base + ulid + "/+1"),
            ("idx with minus sign", base + ulid + "/-1"),
            ("idx with a leading zero", base + ulid + "/01"),
            ("idx 00", base + ulid + "/00"),
            ("idx UInt32.max + 1", base + ulid + "/4294967296"),
            ("idx of 11 digits", base + ulid + "/99999999999"),
            ("idx of 11 zero-padded digits", base + ulid + "/00000000001"),
            ("idx not decimal", base + ulid + "/1a"),
            ("idx hex", base + ulid + "/0x1"),
            ("idx with a dot", base + ulid + "/1.0"),
            // percent-encoding never normalizes into a match
            ("percent-encoded host", "e2ee-att://%61tt/" + ulid + "/0"),
            ("percent-encoded id symbol", base + "%30" + String(ulid.dropFirst()) + "/0"),
            ("percent-encoded idx", base + ulid + "/%30"),
            ("percent-encoded slash", base + ulid + "%2F0"),
        ]
        var checked = 0
        for row in rows {
            guard let url = URL(string: row.url) else {
                XCTFail("\(row.why): not a URL, so the row tests nothing: \(row.url)")
                continue
            }
            XCTAssertNil(AttachmentSchemeHandler.parse(url), "\(row.why): \(row.url)")
            checked += 1
        }
        XCTAssertEqual(checked, rows.count, "every row reached the parser")
    }

    /// Empty delimiters: the same resource spelled a second way. One id,
    /// one URL, so these are rejected like any other variation.
    func testParseRejectsEmptyDelimiters() {
        let canonical = base + ulid + "/0"
        let rows: [(why: String, url: String)] = [
            ("empty query", canonical + "?"),
            ("empty fragment", canonical + "#"),
            ("empty port", "e2ee-att://att:/" + ulid + "/0"),
            ("empty user", "e2ee-att://@att/" + ulid + "/0"),
        ]
        var checked = 0
        for row in rows {
            guard let url = URL(string: row.url) else {
                XCTFail("\(row.why): not a URL, so the row tests nothing: \(row.url)")
                continue
            }
            XCTAssertNil(AttachmentSchemeHandler.parse(url), "\(row.why): \(row.url)")
            checked += 1
        }
        XCTAssertEqual(checked, rows.count, "every row reached the parser")
    }

    // MARK: - Range parsing

    func testRangeParseSatisfiable() {
        let rows: [(header: String?, length: Int, expected: ByteRangeRequest)] = [
            (nil, 100, .whole),
            (nil, 0, .whole),
            ("bytes=0-9", 100, .range(0...9)),
            ("bytes=5-", 100, .range(5...99)),
            ("bytes=-4", 100, .range(96...99)),
            ("bytes=-100", 100, .range(0...99)),
            ("bytes=-1000", 100, .range(0...99)),
            ("bytes=95-1000", 100, .range(95...99)),
            ("bytes=0-99", 100, .range(0...99)),
            ("bytes=99-", 100, .range(99...99)),
            ("bytes=0-0", 100, .range(0...0)),
            ("bytes=10-99999999999999999999999", 100, .range(10...99)),
            ("bytes=0-9", 5, .range(0...4)),
            ("bytes=-1", 1, .range(0...0)),
        ]
        for row in rows {
            XCTAssertEqual(
                ByteRangeRequest.parse(row.header, length: row.length), row.expected,
                "\(row.header ?? "nil") of \(row.length)")
        }
    }

    func testRangeParseUnsatisfiable() {
        let rows: [(header: String, length: Int)] = [
            // start at or past the end
            ("bytes=100-", 100),
            ("bytes=100-200", 100),
            ("bytes=150-", 100),
            ("bytes=99999999999999999999999-", 100),
            // inverted, empty suffix
            ("bytes=9-5", 100),
            ("bytes=-0", 100),
            ("bytes=-00", 100),
            // more than one range
            ("bytes=0-9,20-29", 100),
            ("bytes=0-9, 20-29", 100),
            ("bytes=0-9,", 100),
            // another unit
            ("items=0-9", 100),
            ("byte=0-9", 100),
            ("bytesx=0-9", 100),
            // garbage
            ("", 100),
            ("garbage", 100),
            ("bytes", 100),
            ("bytes=", 100),
            ("bytes=-", 100),
            ("bytes=abc", 100),
            ("bytes=a-b", 100),
            ("bytes=1-2-3", 100),
            ("bytes=+1-5", 100),
            ("bytes=1-+5", 100),
            ("bytes=0x0-9", 100),
            // non-ASCII digits must not pass for digits
            ("bytes=\u{0661}-\u{0662}", 100),
            ("bytes=\u{FF15}-\u{FF19}", 100),
            // an empty body has no satisfiable range
            ("bytes=0-", 0),
            ("bytes=-1", 0),
            ("bytes=0-0", 0),
        ]
        for row in rows {
            XCTAssertEqual(
                ByteRangeRequest.parse(row.header, length: row.length), .unsatisfiable,
                "\(row.header) of \(row.length)")
        }
    }

    // MARK: - Handler answers

    @MainActor
    func testRefusedRequestsAreOpaque404sWithoutDecrypt() throws {
        let probe = DecryptProbe(content: AttachmentContent(data: fixture, mime: "image/png"))
        let handler = AttachmentSchemeHandler(decrypt: probe.decrypt)
        let webView = WKWebView(frame: .zero)
        let valid = try attachmentURL(0)
        var topLevel = URLRequest(url: valid)
        topLevel.mainDocumentURL = valid
        var underAttachmentDocument = URLRequest(url: valid)
        underAttachmentDocument.mainDocumentURL = try attachmentURL(1)
        let rows: [(why: String, request: URLRequest)] = [
            ("wrong host", subresource(try XCTUnwrap(URL(string: "e2ee-att://evil/" + ulid + "/0")))),
            ("lowercase id", subresource(try XCTUnwrap(URL(string: base + ulid.lowercased() + "/0")))),
            ("POST", subresource(valid, method: "POST")),
            ("HEAD", subresource(valid, method: "HEAD")),
            ("main-frame load", topLevel),
            ("document at the scheme", underAttachmentDocument),
        ]
        var first: [String: String]?
        for row in rows {
            let task = load(handler, webView, row.request, row.why)
            assertNotFound(task, row.why)
            let headers = headerMap(task)
            if let first = first {
                XCTAssertEqual(headers, first, "\(row.why): every 404 must be identical")
            } else {
                first = headers
            }
        }
        // Give a wrongly submitted decrypt time to show up.
        XCTAssertEqual(probe.entered.wait(timeout: .now() + 0.5), .timedOut, "a refused request reached decrypt")
        XCTAssertEqual(probe.calls, [], "refused requests must not be decrypted")
    }

    @MainActor
    func testDecryptFailureIsTheSame404() throws {
        let failing = DecryptProbe(content: nil)
        let handler = AttachmentSchemeHandler(decrypt: failing.decrypt)
        let webView = WKWebView(frame: .zero)
        let task = load(handler, webView, subresource(try attachmentURL(3)), "decrypt throws")
        assertNotFound(task, "decrypt throws")
        XCTAssertEqual(failing.calls, ["\(ulid)/3"])
        let refused = load(
            handler, webView, subresource(try XCTUnwrap(URL(string: "e2ee-att://evil/" + ulid + "/3"))), "bad URL")
        assertNotFound(refused, "bad URL")
        // No existence oracle: a missing or undecryptable attachment looks
        // exactly like a URL that was never valid.
        XCTAssertEqual(headerMap(task), headerMap(refused), "decrypt failure vs refused URL")
        XCTAssertFalse(headerMap(task).isEmpty, "headers were read")
    }

    @MainActor
    func testWholeBodyServedVerbatim() throws {
        // PNG magic bytes served as video/mp4: the handler must pass the
        // core's (already whitelisted) mime through, never sniff the body.
        let png = Data([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]) + fixture
        let servedBody = png
        let servedMime = "video/mp4"
        let probe = DecryptProbe(content: AttachmentContent(data: servedBody, mime: servedMime))
        let handler = AttachmentSchemeHandler(decrypt: probe.decrypt)
        let webView = WKWebView(frame: .zero)
        let task = load(handler, webView, subresource(try attachmentURL(5)), "whole body")
        assertServed(task, status: 200, mime: "video/mp4", body: png, contentRange: nil, "200")
        XCTAssertEqual(probe.calls, ["\(ulid)/5"])
        // A late stop for an answered task is a no-op, never another callback.
        handler.webView(webView, stop: task)
        XCTAssertEqual(task.events, [.response, .data, .finish], "after a late stop")

        let empty = DecryptProbe(content: AttachmentContent(data: Data(), mime: "image/gif"))
        let emptyHandler = AttachmentSchemeHandler(decrypt: empty.decrypt)
        let emptyTask = load(emptyHandler, webView, subresource(try attachmentURL(6)), "empty body")
        assertServed(emptyTask, status: 200, mime: "image/gif", body: Data(), contentRange: nil, "empty 200")
    }

    @MainActor
    func testRangeFormsServe206WithExactSlice() throws {
        let probe = DecryptProbe(content: AttachmentContent(data: fixture, mime: "video/mp4"))
        let handler = AttachmentSchemeHandler(decrypt: probe.decrypt)
        let webView = WKWebView(frame: .zero)
        let url = try attachmentURL(1)
        let rows: [(header: String, lower: Int, upper: Int)] = [
            ("bytes=10-19", 10, 19),
            ("bytes=90-", 90, 99),
            ("bytes=-4", 96, 99),
            ("bytes=95-1000", 95, 99),
        ]
        for row in rows {
            let task = load(handler, webView, subresource(url, range: row.header), row.header)
            assertServed(
                task, status: 206, mime: "video/mp4", body: fixture.subdata(in: row.lower..<(row.upper + 1)),
                contentRange: "bytes \(row.lower)-\(row.upper)/100", row.header)
        }
        XCTAssertEqual(probe.calls.count, rows.count, "one decrypt per range request")
    }

    @MainActor
    func testUnsatisfiableRangeIs416() throws {
        let probe = DecryptProbe(content: AttachmentContent(data: fixture, mime: "video/mp4"))
        let handler = AttachmentSchemeHandler(decrypt: probe.decrypt)
        let webView = WKWebView(frame: .zero)
        let url = try attachmentURL(1)
        let rows = ["bytes=100-", "bytes=0-9,20-29", "bytes=-0", "bytes=9-5", "items=0-9"]
        for header in rows {
            let task = load(handler, webView, subresource(url, range: header), header)
            assertUnsatisfiable(task, length: 100, header)
        }
        let empty = DecryptProbe(content: AttachmentContent(data: Data(), mime: "video/mp4"))
        let emptyHandler = AttachmentSchemeHandler(decrypt: empty.decrypt)
        let emptyTask = load(emptyHandler, webView, subresource(url, range: "bytes=0-"), "range of an empty body")
        assertUnsatisfiable(emptyTask, length: 0, "range of an empty body")
    }

    // MARK: - stop

    @MainActor
    func testNoCallbacksAfterStopDuringDecrypt() throws {
        let probe = DecryptProbe(content: AttachmentContent(data: fixture, mime: "image/png"), gated: true)
        defer { probe.release(8) }
        let handler = AttachmentSchemeHandler(decrypt: probe.decrypt)
        let webView = WKWebView(frame: .zero)
        let task = silentTask(subresource(try attachmentURL(0)), "stopped task")
        handler.webView(webView, start: task)
        XCTAssertEqual(probe.entered.wait(timeout: .now() + 10), .success, "decrypt never started")
        handler.webView(webView, stop: task)
        probe.release(1)
        XCTAssertEqual(probe.returned.wait(timeout: .now() + 10), .success, "decrypt never returned")
        // Spins the run loop, so the worker's main-queue delivery runs here.
        wait(for: [task.done], timeout: 1)
        XCTAssertEqual(task.events, [], "a stopped task must get no callback at all")
        XCTAssertEqual(probe.calls, ["\(ulid)/0"])
    }

    @MainActor
    func testStopWhileQueuedSkipsDecrypt() throws {
        let probe = DecryptProbe(content: AttachmentContent(data: fixture, mime: "image/png"), gated: true)
        defer { probe.release(8) }
        let handler = AttachmentSchemeHandler(decrypt: probe.decrypt)
        let webView = WKWebView(frame: .zero)
        // Occupy both decrypt threads so the third job waits in the queue.
        let first = begin(handler, webView, subresource(try attachmentURL(0)), "first")
        let second = begin(handler, webView, subresource(try attachmentURL(1)), "second")
        XCTAssertEqual(probe.entered.wait(timeout: .now() + 10), .success, "first decrypt never started")
        XCTAssertEqual(probe.entered.wait(timeout: .now() + 10), .success, "second decrypt never started")
        let queued = silentTask(subresource(try attachmentURL(2)), "queued task")
        handler.webView(webView, start: queued)
        handler.webView(webView, stop: queued)
        probe.release(3)
        wait(for: [first.done, second.done], timeout: 10)
        wait(for: [queued.done], timeout: 1)
        XCTAssertEqual(queued.events, [], "a stopped task must get no callback at all")
        XCTAssertEqual(probe.calls.sorted(), ["\(ulid)/0", "\(ulid)/1"], "the stopped job must not decrypt")
        assertServed(first, status: 200, mime: "image/png", body: fixture, contentRange: nil, "first")
        assertServed(second, status: 200, mime: "image/png", body: fixture, contentRange: nil, "second")
    }

    @MainActor
    func testStopInsideResponseCallbackEndsTheAnswer() throws {
        let probe = DecryptProbe(content: AttachmentContent(data: fixture, mime: "image/png"))
        let handler = AttachmentSchemeHandler(decrypt: probe.decrypt)
        let webView = WKWebView(frame: .zero)
        let task = silentTask(subresource(try attachmentURL(0)), "stopped mid-answer")
        task.onResponse = { [unowned task] in
            handler.webView(webView, stop: task)
        }
        handler.webView(webView, start: task)
        XCTAssertEqual(probe.returned.wait(timeout: .now() + 10), .success, "decrypt never returned")
        wait(for: [task.done], timeout: 1)
        XCTAssertEqual(task.events, [.response], "nothing may follow a stop, even between two callbacks")
        XCTAssertTrue(task.body.isEmpty, "no body after the stop")
    }

    // MARK: - Threads

    @MainActor
    func testAtMostTwoDecryptsRunConcurrently() throws {
        let probe = DecryptProbe(content: AttachmentContent(data: fixture, mime: "image/png"), gated: true)
        defer { probe.release(16) }
        let handler = AttachmentSchemeHandler(decrypt: probe.decrypt)
        let webView = WKWebView(frame: .zero)
        var tasks: [FakeSchemeTask] = []
        for idx in 0..<5 {
            tasks.append(begin(handler, webView, subresource(try attachmentURL(UInt32(idx))), "task \(idx)"))
        }
        XCTAssertEqual(probe.entered.wait(timeout: .now() + 10), .success, "first decrypt never started")
        XCTAssertEqual(probe.entered.wait(timeout: .now() + 10), .success, "second decrypt never started")
        // Three jobs are queued and both running decrypts are blocked: a
        // third thread would enter now.
        XCTAssertEqual(
            probe.entered.wait(timeout: .now() + 1), .timedOut, "a third decrypt started while two were running")
        XCTAssertEqual(probe.activeNow, 2, "decrypts running while blocked")
        probe.release(5)
        wait(for: tasks.map { $0.done }, timeout: 20)
        XCTAssertEqual(probe.calls.count, 5)
        XCTAssertLessThanOrEqual(probe.peakActive, 2, "decrypt concurrency cap")
        XCTAssertEqual(probe.peakActive, 2, "two decrypts did run in parallel")
        for (idx, task) in tasks.enumerated() {
            assertServed(task, status: 200, mime: "image/png", body: fixture, contentRange: nil, "task \(idx)")
        }
    }

    @MainActor
    func testDecryptNeverRunsOnMain() throws {
        let probe = DecryptProbe(content: AttachmentContent(data: fixture, mime: "image/png"))
        let handler = AttachmentSchemeHandler(decrypt: probe.decrypt)
        let failing = DecryptProbe(content: nil)
        let failingHandler = AttachmentSchemeHandler(decrypt: failing.decrypt)
        let webView = WKWebView(frame: .zero)
        let url = try attachmentURL(0)
        _ = load(handler, webView, subresource(url), "200")
        _ = load(handler, webView, subresource(url, range: "bytes=0-9"), "206")
        _ = load(handler, webView, subresource(url, range: "bytes=500-"), "416")
        _ = load(failingHandler, webView, subresource(url), "404")
        XCTAssertEqual(probe.calls.count, 3)
        XCTAssertEqual(failing.calls.count, 1)
        XCTAssertFalse(probe.ranOnMain, "decrypt ran on the main thread")
        XCTAssertFalse(failing.ranOnMain, "failing decrypt ran on the main thread")
    }
}
