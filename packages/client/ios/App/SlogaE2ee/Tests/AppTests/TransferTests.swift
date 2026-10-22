// TransferTests.swift: IE Wave 3 lane T7. D6 native ciphertext transfer:
// the Autumn host pin, refused redirects, header checks and the fetch cap.
//
// Every request AttachmentTransfer makes goes through T7ScriptedProtocol
// (installed via `AttachmentTransfer.protocolClassesForTesting`), which
// records it and answers from a per-host script. Nothing reaches the network.
// An unscripted host gets a 500, so even a regression that lets a request
// through lands on "pending" and never on an engine store method.
//
// Not covered here, because they call into the engine with the app's real
// store: a 200 within the cap (attachment_store), a 404/410
// (attachment_mark_unavailable) and a real upload (needs a prepared
// attachment). The network tests below do build `E2eeRuntime.shared`'s
// engine (fetch asks for it before the request), which opens no store.
import XCTest
@testable import SlogaE2ee

private let t7Pin = "https://app.sloga.gg/media"
private let t7Header = "X-Session-Token"
private let t7Value = "t7-session-value"
private let t7RedirectHost = "t7-redirect.invalid"
private let t7MiB = 1024 * 1024
/// Chunks of the oversized stream: 32 MiB against the 21 MiB fetch cap.
private let t7StreamChunks = 32

// MARK: - Scripted URLProtocol

private enum T7Answer {
    case status(Int)
    case redirect(to: String)
    /// A 200 that streams `chunks` MiB, one MiB at a time, paced so a
    /// reader that cancels is seen to stop the stream early.
    case stream(chunks: Int, declaredLength: Int?)
}

private struct T7Request {
    let url: URL?
    let method: String?
    let headers: [String: String]

    func value(_ name: String) -> String? {
        headers.first { $0.key.caseInsensitiveCompare(name) == .orderedSame }?.value
    }
}

private final class T7Log: @unchecked Sendable {
    static let shared = T7Log()

    private let lock = NSLock()
    private var answers: [String: T7Answer] = [:]
    private var log: [T7Request] = []
    private var chunks = 0

    func reset() {
        lock.lock()
        answers = [:]
        log = []
        chunks = 0
        lock.unlock()
    }

    func script(_ host: String, _ answer: T7Answer) {
        lock.lock()
        answers[host.lowercased()] = answer
        lock.unlock()
    }

    func answer(forHost host: String?) -> T7Answer {
        lock.lock()
        defer { lock.unlock() }
        guard let host = host, let answer = answers[host.lowercased()] else {
            return .status(500)
        }
        return answer
    }

    func record(_ request: URLRequest) {
        lock.lock()
        log.append(T7Request(url: request.url, method: request.httpMethod, headers: request.allHTTPHeaderFields ?? [:]))
        lock.unlock()
    }

    var requests: [T7Request] {
        lock.lock()
        defer { lock.unlock() }
        return log
    }

    func noteChunk() {
        lock.lock()
        chunks += 1
        lock.unlock()
    }

    var chunksDelivered: Int {
        lock.lock()
        defer { lock.unlock() }
        return chunks
    }
}

private struct T7Unchecked<Value>: @unchecked Sendable {
    let value: Value
}

private final class T7ResultBox<Value>: @unchecked Sendable {
    private let lock = NSLock()
    private var stored: Value?

    func store(_ value: Value) {
        lock.lock()
        stored = value
        lock.unlock()
    }

    func load() -> Value? {
        lock.lock()
        defer { lock.unlock() }
        return stored
    }
}

private final class T7ScriptedProtocol: URLProtocol {
    private let stopLock = NSLock()
    private var stopped = false
    private let stopSignal = DispatchSemaphore(value: 0)

    override class func canInit(with request: URLRequest) -> Bool {
        true
    }

    override class func canonicalRequest(for request: URLRequest) -> URLRequest {
        request
    }

    override func startLoading() {
        T7Log.shared.record(request)
        guard let client = client, let url = request.url else {
            return
        }
        switch T7Log.shared.answer(forHost: url.host) {
        case .status(let code):
            guard let response = HTTPURLResponse(url: url, statusCode: code, httpVersion: "HTTP/1.1",
                                                 headerFields: ["Content-Type": "application/octet-stream"])
            else {
                client.urlProtocol(self, didFailWithError: URLError(.badServerResponse))
                return
            }
            client.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
            client.urlProtocol(self, didLoad: Data("t7".utf8))
            client.urlProtocolDidFinishLoading(self)

        case .redirect(let target):
            guard let targetURL = URL(string: target),
                  let response = HTTPURLResponse(url: url, statusCode: 302, httpVersion: "HTTP/1.1",
                                                 headerFields: ["Location": target])
            else {
                client.urlProtocol(self, didFailWithError: URLError(.badServerResponse))
                return
            }
            // A copy of the request, custom headers included, as a following
            // session would send it on.
            var next = request
            next.url = targetURL
            client.urlProtocol(self, wasRedirectedTo: next, redirectResponse: response)
            // If the redirect is refused the load is not stopped: hand the
            // 302 over as the final response, as a real server's would be.
            let box = T7Unchecked(value: (self, client, response))
            DispatchQueue.global(qos: .userInitiated).async {
                let (proto, client, response) = box.value
                if proto.waitForStop(milliseconds: 1000) {
                    return
                }
                client.urlProtocol(proto, didReceive: response, cacheStoragePolicy: .notAllowed)
                client.urlProtocolDidFinishLoading(proto)
            }

        case .stream(let chunks, let declaredLength):
            var headers = ["Content-Type": "application/octet-stream"]
            if let declaredLength = declaredLength {
                headers["Content-Length"] = String(declaredLength)
            }
            guard let response = HTTPURLResponse(url: url, statusCode: 200, httpVersion: "HTTP/1.1", headerFields: headers) else {
                client.urlProtocol(self, didFailWithError: URLError(.badServerResponse))
                return
            }
            client.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
            let box = T7Unchecked(value: (self, client))
            DispatchQueue.global(qos: .userInitiated).async {
                let (proto, client) = box.value
                let chunk = Data(repeating: 0x41, count: t7MiB)
                for _ in 0..<chunks {
                    client.urlProtocol(proto, didLoad: chunk)
                    T7Log.shared.noteChunk()
                    if proto.waitForStop(milliseconds: 150) {
                        return
                    }
                }
                client.urlProtocolDidFinishLoading(proto)
            }
        }
    }

    override func stopLoading() {
        stopLock.lock()
        let first = !stopped
        stopped = true
        stopLock.unlock()
        if first {
            stopSignal.signal()
        }
    }

    /// True once the session has stopped this load (consumes the signal).
    fileprivate func waitForStop(milliseconds: Int) -> Bool {
        stopSignal.wait(timeout: .now() + .milliseconds(milliseconds)) == .success
    }
}

// MARK: - Tests

final class TransferTests: XCTestCase {
    override func setUp() {
        super.setUp()
        T7Log.shared.reset()
        AttachmentTransfer.protocolClassesForTesting = [T7ScriptedProtocol.self]
    }

    override func tearDown() {
        AttachmentTransfer.protocolClassesForTesting = nil
        T7Log.shared.reset()
        super.tearDown()
    }

    // MARK: Host pin

    func testPinnedBaseIsTheInfoPlistAutumnOrigin() {
        XCTAssertEqual(AttachmentTransfer.pinnedBase()?.absoluteString, "https://app.sloga.gg/media")
    }

    func testIsAllowedUploadMatrix() throws {
        let base = try XCTUnwrap(URL(string: t7Pin))
        let accepted = [
            "https://app.sloga.gg/media/e2ee",
            "https://APP.Sloga.GG/media/e2ee",
            "https://app.sloga.gg:443/media/e2ee",
        ]
        let refused = [
            "http://app.sloga.gg/media/e2ee",
            "https://evil.example/media/e2ee",
            "https://app.sloga.gg.evil.example/media/e2ee",
            "https://evilapp.sloga.gg/media/e2ee",
            "https://sloga.gg/media/e2ee",
            "https://app.sloga.gg./media/e2ee",
            "https://app.sloga.gg:8443/media/e2ee",
            "https://app.sloga.gg:80/media/e2ee",
            "https://user@app.sloga.gg/media/e2ee",
            "https://user:pw@app.sloga.gg/media/e2ee",
            "https://:pw@app.sloga.gg/media/e2ee",
            "https://app.sloga.gg/media/e2ee?x=1",
            "https://app.sloga.gg/media/e2ee?",
            "https://app.sloga.gg/media/e2ee#f",
            "https://app.sloga.gg/media/e2ee#",
            "https://app.sloga.gg/media/e2ee/",
            "https://app.sloga.gg/media/e2ee/abc",
            "https://app.sloga.gg/media/e2ee/abc/def",
            "https://app.sloga.gg/e2ee",
            "https://app.sloga.gg/mediax/e2ee",
            "https://app.sloga.gg/media/E2EE",
            "https://app.sloga.gg/media/e2eex",
            "https://app.sloga.gg//media/e2ee",
            "https://app.sloga.gg/media/./e2ee",
            "https://app.sloga.gg/media/x/../e2ee",
            "https://app.sloga.gg/media/e2ee/.",
            "https://app.sloga.gg/media%2Fe2ee",
            "https://app.sloga.gg/media/e2ee%2F",
            "https://app.sloga.gg/media/%65%32%65%65",
            "wss://app.sloga.gg/media/e2ee",
            "file:///media/e2ee",
        ]
        for raw in accepted {
            try expectAllowed(raw, blob: false, true, base: base)
        }
        for raw in refused {
            try expectAllowed(raw, blob: false, false, base: base)
        }
    }

    func testIsAllowedFetchMatrix() throws {
        let base = try XCTUnwrap(URL(string: t7Pin))
        let longest = String(repeating: "a", count: 125) + "-_Z"
        let accepted = [
            "https://app.sloga.gg/media/e2ee/a",
            "https://app.sloga.gg/media/e2ee/abcDEF123",
            "https://app.sloga.gg/media/e2ee/A-_z09",
            "https://app.sloga.gg/media/e2ee/01HZY3K6V4QK1E7XJ9N2M5T8RB",
            "https://app.sloga.gg/media/e2ee/" + longest,
            "https://APP.sloga.gg/media/e2ee/abc",
            "https://app.sloga.gg:443/media/e2ee/abc",
        ]
        let refused = [
            "https://app.sloga.gg/media/e2ee/" + longest + "x",
            "https://app.sloga.gg/media/e2ee/",
            "https://app.sloga.gg/media/e2ee",
            "https://app.sloga.gg/media/e2ee/abc/",
            "https://app.sloga.gg/media/e2ee/abc/def",
            "https://app.sloga.gg/media/e2ee//abc",
            "https://app.sloga.gg/media/e2ee/a.b",
            "https://app.sloga.gg/media/e2ee/.",
            "https://app.sloga.gg/media/e2ee/..",
            "https://app.sloga.gg/media/e2ee/../e2ee/abc",
            "https://app.sloga.gg/media/x/../e2ee/abc",
            "https://app.sloga.gg/media/e2ee/./abc",
            "https://app.sloga.gg/media/e2ee/%2E%2E",
            "https://app.sloga.gg/media/e2ee/%2e%2e",
            "https://app.sloga.gg/media/e2ee/abc%2Fdef",
            "https://app.sloga.gg/media/e2ee/abc%2fdef",
            "https://app.sloga.gg/media/e2ee%2Fabc",
            "https://app.sloga.gg/media/e2ee/%61bc",
            "https://app.sloga.gg/media/e2ee/abc%20",
            "https://app.sloga.gg/media/e2ee/%C3%A9",
            "https://app.sloga.gg/media/e2ee/abc;x",
            "https://app.sloga.gg/media/e2ee/abc?x=1",
            "https://app.sloga.gg/media/e2ee/abc?",
            "https://app.sloga.gg/media/e2ee/abc#f",
            "http://app.sloga.gg/media/e2ee/abc",
            "https://evil.example/media/e2ee/abc",
            "https://app.sloga.gg.evil.example/media/e2ee/abc",
            "https://app.sloga.gg:8443/media/e2ee/abc",
            "https://user@app.sloga.gg/media/e2ee/abc",
            "https://user:pw@app.sloga.gg/media/e2ee/abc",
            "https://app.sloga.gg/media/E2EE/abc",
            "https://app.sloga.gg/e2ee/abc",
            "https://app.sloga.gg/mediax/e2ee/abc",
            "https://app.sloga.gg/media/e2eex/abc",
            "https://app.sloga.gg/other/media/e2ee/abc",
        ]
        for raw in accepted {
            try expectAllowed(raw, blob: true, true, base: base)
        }
        for raw in refused {
            try expectAllowed(raw, blob: true, false, base: base)
        }
    }

    func testIsAllowedRefusesANonHttpsBase() throws {
        let httpBase = try XCTUnwrap(URL(string: "http://app.sloga.gg/media"))
        try expectAllowed("http://app.sloga.gg/media/e2ee", blob: false, false, base: httpBase)
        try expectAllowed("https://app.sloga.gg/media/e2ee", blob: false, false, base: httpBase)
        try expectAllowed("http://app.sloga.gg/media/e2ee/abc", blob: true, false, base: httpBase)
    }

    // MARK: Rejected before any request

    func testFetchRejectsAnOffPinURLBeforeAnyRequest() {
        let offPin = [
            "https://evil.example/media/e2ee/abcDEF123",
            "http://app.sloga.gg/media/e2ee/abcDEF123",
            "https://app.sloga.gg:8443/media/e2ee/abcDEF123",
            "https://user:pw@app.sloga.gg/media/e2ee/abcDEF123",
            "https://app.sloga.gg/media/e2ee",
            "https://app.sloga.gg/media/e2ee/abc/def",
            "https://app.sloga.gg/media/e2ee/abc%2Fdef",
            "https://app.sloga.gg/media/e2ee/../e2ee/abc",
            "https://app.sloga.gg/media/e2ee/abc?x=1",
            "",
            "not a url",
        ]
        for raw in offPin {
            assertRejected(fetch(raw), field: "url", "fetch \(raw.debugDescription)")
        }
        XCTAssertEqual(T7Log.shared.requests.count, 0, "a refused fetch URL produced a request")
    }

    func testFetchRejectsABadAuthHeaderBeforeAnyRequest() {
        let url = t7Pin + "/e2ee/abcDEF123"
        let badHeaders = [
            "X Session-Token",
            "X-Session-Token:",
            "",
            String(repeating: "A", count: 65),
            "X-S\u{E9}ssion",
            "X-Session\r\nX-Evil",
        ]
        for header in badHeaders {
            assertRejected(fetch(url, header: header), field: "authHeader", "fetch header \(header.debugDescription)")
        }
        XCTAssertEqual(T7Log.shared.requests.count, 0, "a refused fetch header produced a request")
    }

    func testFetchRejectsAnAuthValueThatCouldSplitTheRequest() {
        let url = t7Pin + "/e2ee/abcDEF123"
        let badValues = [
            "t7\rvalue",
            "t7\nvalue",
            "t7\r\nX-Evil: 1",
            "t7\u{0}value",
        ]
        for value in badValues {
            assertRejected(fetch(url, value: value), field: "authValue", "fetch value \(value.debugDescription)")
        }
        XCTAssertEqual(T7Log.shared.requests.count, 0, "a refused fetch value produced a request")
    }

    func testUploadRejectsADisallowedURLBeforeAnyRequest() {
        let disallowed = [
            "https://evil.example/media/e2ee",
            "http://app.sloga.gg/media/e2ee",
            "https://app.sloga.gg/media/e2ee/",
            "https://app.sloga.gg/media/e2ee/abcDEF123",
            "https://app.sloga.gg/media/e2ee?x=1",
            "https://app.sloga.gg/media/./e2ee",
            "https://app.sloga.gg/media%2Fe2ee",
            "https://app.sloga.gg/e2ee",
            "",
        ]
        for raw in disallowed {
            assertRejected(upload(raw), field: "url", "upload \(raw.debugDescription)")
        }
        XCTAssertEqual(T7Log.shared.requests.count, 0, "a refused upload URL produced a request")
    }

    func testUploadRejectsBadAuthBeforeAnyRequest() {
        let url = t7Pin + "/e2ee"
        for header in ["X Session-Token", "X-Session-Token:", "", String(repeating: "B", count: 65)] {
            assertRejected(upload(url, header: header), field: "authHeader", "upload header \(header.debugDescription)")
        }
        for value in ["t7\rvalue", "t7\nvalue", "t7\u{0}value"] {
            assertRejected(upload(url, value: value), field: "authValue", "upload value \(value.debugDescription)")
        }
        XCTAssertEqual(T7Log.shared.requests.count, 0, "a refused upload header produced a request")
    }

    // MARK: Network behaviour that never reaches an engine method

    func testFetchRequestIsAGetWithTheAuthHeaderAndNoCookie() throws {
        let url = t7Pin + "/e2ee/T7shape"
        assertResolved(fetch(url), "pending", "fetch answered 500")
        let requests = T7Log.shared.requests
        XCTAssertEqual(requests.count, 1)
        let sent = try XCTUnwrap(requests.first)
        XCTAssertEqual(sent.url?.absoluteString, url)
        XCTAssertEqual(sent.method, "GET")
        XCTAssertEqual(sent.value(t7Header), t7Value)
        XCTAssertNil(sent.value("Cookie"), "the fetch carried a Cookie header")
    }

    func testFetchAcceptsA64ByteHeaderName() {
        let header = String(repeating: "C", count: 64)
        assertResolved(fetch(t7Pin + "/e2ee/T7h64", header: header), "pending", "64-byte header name")
        let requests = T7Log.shared.requests
        XCTAssertEqual(requests.count, 1)
        XCTAssertEqual(requests.first?.value(header), t7Value)
    }

    func testFetchNon200StatusesStayPending() {
        for status in [500, 502, 503, 401, 403, 429, 204, 206] {
            T7Log.shared.reset()
            T7Log.shared.script("app.sloga.gg", .status(status))
            assertResolved(fetch(t7Pin + "/e2ee/T7status"), "pending", "status \(status)")
            XCTAssertEqual(T7Log.shared.requests.count, 1, "status \(status)")
        }
    }

    func testFetchRefusesARedirect() {
        let targets = [
            "https://\(t7RedirectHost)/media/e2ee/T7redirected",
            t7Pin + "/e2ee/T7redirectedSameHost",
        ]
        for target in targets {
            T7Log.shared.reset()
            T7Log.shared.script("app.sloga.gg", .redirect(to: target))
            assertResolved(fetch(t7Pin + "/e2ee/T7redirect"), "pending", "302 to \(target)")
            let requests = T7Log.shared.requests
            XCTAssertEqual(requests.count, 1, "the redirect to \(target) was followed")
            XCTAssertEqual(requests.first?.url?.absoluteString, t7Pin + "/e2ee/T7redirect")
            XCTAssertFalse(requests.contains { $0.url?.host == t7RedirectHost }, "the session token went to the redirect target")
        }
    }

    func testFetchStopsReadingAStreamedBodyOverTheCap() {
        T7Log.shared.script("app.sloga.gg", .stream(chunks: t7StreamChunks, declaredLength: nil))
        assertResolved(fetch(t7Pin + "/e2ee/T7big"), "pending", "streamed 32 MiB body")
        XCTAssertEqual(T7Log.shared.requests.count, 1)
        let delivered = T7Log.shared.chunksDelivered
        XCTAssertLessThan(delivered, t7StreamChunks, "the transfer read the whole oversized body")
        // 21 whole MiB fit under the cap, so the cut comes with the 22nd.
        XCTAssertGreaterThanOrEqual(delivered, 22, "the transfer stopped before 21 MiB had arrived")
    }

    func testFetchRefusesADeclaredOversizeBodyAtTheHeaders() {
        T7Log.shared.script("app.sloga.gg", .stream(chunks: t7StreamChunks, declaredLength: t7StreamChunks * t7MiB))
        assertResolved(fetch(t7Pin + "/e2ee/T7declared"), "pending", "declared 32 MiB body")
        XCTAssertEqual(T7Log.shared.requests.count, 1)
        XCTAssertLessThanOrEqual(T7Log.shared.chunksDelivered, 2, "a declared oversize body was read")
    }

    // MARK: Harness controls (prove the scripted protocol can show the bad case)

    func testHarnessControlAPlainSessionFollowsTheRedirectAndForwardsTheToken() throws {
        T7Log.shared.script("app.sloga.gg", .redirect(to: "https://\(t7RedirectHost)/media/e2ee/T7redirected"))
        let session = URLSession(configuration: plainConfiguration())
        defer { session.invalidateAndCancel() }
        var request = URLRequest(url: try XCTUnwrap(URL(string: t7Pin + "/e2ee/T7plain")))
        request.setValue(t7Value, forHTTPHeaderField: t7Header)
        let done = expectation(description: "plain session finished")
        session.dataTask(with: request) { _, _, _ in
            done.fulfill()
        }.resume()
        wait(for: [done], timeout: 30)

        let requests = T7Log.shared.requests
        XCTAssertEqual(requests.count, 2, "a default session should have followed the redirect")
        XCTAssertEqual(requests.last?.url?.host, t7RedirectHost)
        XCTAssertEqual(requests.last?.value(t7Header), t7Value, "a default session forwards the token on a redirect")
    }

    func testHarnessControlAPlainSessionReadsTheWholeOversizedStream() throws {
        T7Log.shared.script("app.sloga.gg", .stream(chunks: t7StreamChunks, declaredLength: nil))
        let session = URLSession(configuration: plainConfiguration())
        defer { session.invalidateAndCancel() }
        let received = T7ResultBox<Int>()
        let done = expectation(description: "plain session finished")
        session.dataTask(with: try XCTUnwrap(URL(string: t7Pin + "/e2ee/T7plainBig"))) { data, _, _ in
            received.store(data?.count ?? -1)
            done.fulfill()
        }.resume()
        wait(for: [done], timeout: 30)

        XCTAssertEqual(received.load(), t7StreamChunks * t7MiB)
        XCTAssertEqual(T7Log.shared.chunksDelivered, t7StreamChunks)
    }

    // MARK: Helpers

    private func expectAllowed(_ raw: String, blob: Bool, _ expected: Bool, base: URL,
                               file: StaticString = #filePath, line: UInt = #line) throws {
        let url = try XCTUnwrap(URL(string: raw), "test URL does not parse: \(raw)", file: file, line: line)
        XCTAssertEqual(AttachmentTransfer.isAllowed(url, base: base, blob: blob), expected,
                       "\(blob ? "fetch" : "upload") \(raw) against \(base.absoluteString)", file: file, line: line)
    }

    private func plainConfiguration() -> URLSessionConfiguration {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [T7ScriptedProtocol.self] + (configuration.protocolClasses ?? [])
        return configuration
    }

    private func fetch(_ url: String, header: String = t7Header, value: String = t7Value) -> Result<String, Error>? {
        let localId = "t7-" + UUID().uuidString
        return offMain {
            try AttachmentTransfer.fetch(localId: localId, url: url, authHeader: header, authValue: value)
        }
    }

    private func upload(_ url: String, header: String = t7Header, value: String = t7Value) -> Result<String, Error>? {
        let localId = "t7-" + UUID().uuidString
        return offMain {
            try AttachmentTransfer.upload(localId: localId, url: url, authHeader: header, authValue: value, recipientsJson: "[]")
        }
    }

    /// Transfers block and assert they are off main: run on an 8 MiB thread.
    private func offMain(_ body: @escaping () throws -> String) -> Result<String, Error>? {
        let done = expectation(description: "transfer call returned")
        let box = T7ResultBox<Result<String, Error>>()
        runOnDedicatedThread(name: "gg.sloga.e2ee.t7-test") {
            box.store(Result { try body() })
            done.fulfill()
        }
        wait(for: [done], timeout: 30)
        return box.load()
    }

    private func assertRejected(_ outcome: Result<String, Error>?, field: String, _ label: String,
                                file: StaticString = #filePath, line: UInt = #line) {
        guard let outcome = outcome else {
            XCTFail("\(label): the call did not return in time", file: file, line: line)
            return
        }
        switch outcome {
        case .success(let resolved):
            XCTFail("\(label): expected invalid_argument(\(field)), resolved \(resolved)", file: file, line: line)
        case .failure(let error):
            XCTAssertEqual(error as? E2eeReject, E2eeReject.invalidArgument(field), label, file: file, line: line)
            XCTAssertEqual(rejectJson(for: error), "{\"type\":\"invalid_argument\",\"field\":\"\(field)\"}", label, file: file, line: line)
        }
    }

    private func assertResolved(_ outcome: Result<String, Error>?, _ expected: String, _ label: String,
                                file: StaticString = #filePath, line: UInt = #line) {
        guard let outcome = outcome else {
            XCTFail("\(label): the call did not return in time", file: file, line: line)
            return
        }
        switch outcome {
        case .success(let resolved):
            XCTAssertEqual(resolved, jsonQuote(expected), label, file: file, line: line)
        case .failure(let error):
            XCTFail("\(label): expected \(expected), rejected \(rejectJson(for: error))", file: file, line: line)
        }
    }
}
