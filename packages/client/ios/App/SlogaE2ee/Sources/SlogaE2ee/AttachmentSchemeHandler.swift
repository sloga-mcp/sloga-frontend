// AttachmentSchemeHandler.swift: the `e2ee-att://` scheme that serves
// decrypted E2EE attachments to the webview (IE plan D6 "Serving", "URL
// shape", "Handler behavior"). The iOS analog of the desktop `e2ee-att`
// protocol and Android's `E2eeWebViewClient`.
//
// This is the ONLY path on which decrypted attachment bytes reach the
// webview. The key never leaves the Rust core; the core validates the id,
// digest-verifies before decrypting and degrades the mime to its render
// whitelist (`serve_attachment_for_render`). This file serves that result
// verbatim from memory, adds the hardening headers, and answers every
// failure with the same empty 404 (no existence oracle).
import AcutestE2eeBindings
import Foundation
import WebKit

/// One Range header, parsed against a body of `length` bytes.
enum ByteRangeRequest: Equatable {
    /// No Range header: 200 with the whole body.
    case whole
    /// One satisfiable range, inclusive bounds already clamped to `length`: 206.
    case range(ClosedRange<Int>)
    /// Unparseable, multi-range or unsatisfiable: 416.
    case unsatisfiable

    static func parse(_ header: String?, length: Int) -> ByteRangeRequest {
        guard let header = header else {
            return .whole
        }
        // An empty body has no satisfiable range at all.
        guard length > 0 else {
            return .unsatisfiable
        }
        // Parsed as ASCII bytes: a Unicode lookalike must never pass for
        // a digit, a dash or the unit.
        let bytes = trimOWS(Array(header.utf8)[...])
        guard let equals = bytes.firstIndex(of: UInt8(ascii: "=")) else {
            return .unsatisfiable
        }
        guard asciiCaseInsensitiveEquals(trimOWS(bytes[..<equals]), "bytes") else {
            return .unsatisfiable
        }
        let spec = bytes[(equals + 1)...]
        // One range only: a multi-range answer would be multipart, which
        // nothing here asks for.
        guard !spec.contains(UInt8(ascii: ",")) else {
            return .unsatisfiable
        }
        guard let dash = spec.firstIndex(of: UInt8(ascii: "-")) else {
            return .unsatisfiable
        }
        let first = trimOWS(spec[..<dash])
        let last = trimOWS(spec[(dash + 1)...])
        let end = length - 1

        if first.isEmpty {
            // Suffix form `bytes=-n`: the last n bytes.
            guard let count = saturatingDecimal(last), count > 0 else {
                return .unsatisfiable
            }
            return .range(max(0, length - count)...end)
        }
        guard let start = saturatingDecimal(first), start < length else {
            return .unsatisfiable
        }
        if last.isEmpty {
            // Open form `bytes=a-`, what AVFoundation sends.
            return .range(start...end)
        }
        guard let stop = saturatingDecimal(last), start <= stop else {
            return .unsatisfiable
        }
        return .range(start...min(stop, end))
    }
}

/// Space and horizontal tab (HTTP optional whitespace) trimmed from both ends.
private func trimOWS(_ bytes: ArraySlice<UInt8>) -> ArraySlice<UInt8> {
    var slice = bytes
    while let byte = slice.first, byte == 0x20 || byte == 0x09 {
        slice = slice.dropFirst()
    }
    while let byte = slice.last, byte == 0x20 || byte == 0x09 {
        slice = slice.dropLast()
    }
    return slice
}

private func asciiCaseInsensitiveEquals(_ bytes: ArraySlice<UInt8>, _ word: String) -> Bool {
    let expected = Array(word.utf8)
    guard bytes.count == expected.count else {
        return false
    }
    for (byte, want) in zip(bytes, expected) {
        let lowered = (byte >= 0x41 && byte <= 0x5A) ? byte | 0x20 : byte
        if lowered != want {
            return false
        }
    }
    return true
}

/// A non-empty run of ASCII digits, saturating at `Int.max` instead of
/// overflowing (an absurd first position then fails `< length`, an absurd
/// last position clamps). Anything else, signs included, is nil.
private func saturatingDecimal(_ bytes: ArraySlice<UInt8>) -> Int? {
    guard !bytes.isEmpty else {
        return nil
    }
    var value = 0
    for byte in bytes {
        guard byte >= 0x30 && byte <= 0x39 else {
            return nil
        }
        let (times, overflowTimes) = value.multipliedReportingOverflow(by: 10)
        let (sum, overflowSum) = times.addingReportingOverflow(Int(byte - 0x30))
        value = (overflowTimes || overflowSum) ? Int.max : sum
    }
    return value
}

/// The scheme, outside the (main-actor) class so the pure URL parser can
/// read it from any thread.
private let attachmentScheme = "e2ee-att"

/// Decrypts run here, never on main. Two threads = at most two plaintexts of
/// up to 20 MiB (the core cap) in flight at once: each Range request
/// re-decrypts the whole file, and a `<video>` issues several, so an
/// uncapped fan-out is a jetsam kill. One pool per process, however many
/// handlers exist.
private let attachmentWorkers = WorkerPool(name: "gg.sloga.e2ee.att", threads: 2)

/// The real decrypt (the default `Decrypt`). Never provisions: the core's
/// render path answers an unprovisioned store with an error, which becomes
/// the same 404 as everything else.
private func serveFromEngine(_ messageId: String, _ idx: UInt32) throws -> AttachmentContent {
    dispatchPrecondition(condition: .notOnQueue(.main))
    return try E2eeRuntime.shared.withBackgroundTask("gg.sloga.e2ee.att") {
        dispatchPrecondition(condition: .notOnQueue(.main))
        return try E2eeRuntime.shared.engine().serveAttachmentForRender(messageId: messageId, idx: idx)
    }
}

/// Set on main by `stop`, read by the worker so a task WebKit has already
/// given up on is not decrypted for nothing.
private final class StopFlag: @unchecked Sendable {
    private let lock = NSLock()
    private var stopped = false

    func stop() {
        lock.lock()
        stopped = true
        lock.unlock()
    }

    var isStopped: Bool {
        lock.lock()
        defer { lock.unlock() }
        return stopped
    }
}

/// A finished answer waiting to be handed to WebKit on main. A class, so the
/// body can be zeroed in place after WebKit has it (a struct copy would make
/// the wipe hit a fresh copy instead of our buffer).
private final class PreparedReply: @unchecked Sendable {
    let status: Int
    let headers: [String: String]
    var body: Data

    init(status: Int, headers: [String: String], body: Data = Data()) {
        self.status = status
        self.headers = headers
        self.body = body
    }

    /// Best effort: WebKit's own copy is WebKit's.
    func wipe() {
        zeroize(&body)
    }
}

/// Headers on EVERY answer, errors included. no-store keeps plaintext out of
/// the webview disk cache; nosniff + `sandbox` mean no sender-controlled
/// bytes can become a scriptable document. There is deliberately no
/// Access-Control-Allow-Origin, so a webview `fetch` of the scheme stays
/// blocked (as on desktop): only `<img>`/`<video>`/`<audio>` can use it.
private func hardeningHeaders() -> [String: String] {
    [
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy": "sandbox",
    ]
}

/// The one opaque failure: missing, not ready, digest mismatch, bad URL and
/// refused navigation are indistinguishable.
private func notFoundReply() -> PreparedReply {
    var headers = hardeningHeaders()
    headers["Content-Length"] = "0"
    return PreparedReply(status: 404, headers: headers)
}

/// Worker side of one request: decrypt, then cut the body for the Range.
/// nil = the task was stopped, nothing to answer.
private func prepareReply(
    messageId: String,
    idx: UInt32,
    rangeHeader: String?,
    flag: StopFlag,
    decrypt: AttachmentSchemeHandler.Decrypt
) -> PreparedReply? {
    dispatchPrecondition(condition: .notOnQueue(.main))
    if flag.isStopped {
        return nil
    }
    var content: AttachmentContent
    do {
        content = try decrypt(messageId, idx)
    } catch {
        // The error is never inspected or surfaced: every decrypt failure
        // is the same 404.
        return notFoundReply()
    }
    if flag.isStopped {
        zeroize(&content.data)
        return nil
    }

    let length = content.data.count
    var headers = hardeningHeaders()
    switch ByteRangeRequest.parse(rangeHeader, length: length) {
    case .whole:
        // The core's mime is already whitelist-degraded; re-deriving it here
        // (from bytes or a name) would be a second, weaker whitelist.
        headers["Content-Type"] = content.mime
        headers["Content-Length"] = String(length)
        headers["Accept-Ranges"] = "bytes"
        let reply = PreparedReply(status: 200, headers: headers, body: content.data)
        // Drop our second reference so the reply holds the only one and its
        // wipe lands on this buffer.
        content.data = Data()
        return reply
    case .range(let range):
        let base = content.data.startIndex
        let body = content.data.subdata(in: (base + range.lowerBound)..<(base + range.upperBound + 1))
        zeroize(&content.data)
        headers["Content-Type"] = content.mime
        headers["Content-Length"] = String(body.count)
        headers["Accept-Ranges"] = "bytes"
        headers["Content-Range"] = "bytes \(range.lowerBound)-\(range.upperBound)/\(length)"
        return PreparedReply(status: 206, headers: headers, body: body)
    case .unsatisfiable:
        zeroize(&content.data)
        headers["Content-Length"] = "0"
        headers["Content-Range"] = "bytes */\(length)"
        return PreparedReply(status: 416, headers: headers)
    }
}

final class AttachmentSchemeHandler: NSObject, WKURLSchemeHandler {
    static let scheme = attachmentScheme

    typealias Decrypt = (_ messageId: String, _ idx: UInt32) throws -> AttachmentContent

    private let decrypt: Decrypt

    /// Tasks started and not yet answered or stopped. Main-confined: WebKit
    /// calls start/stop on main and every answer is delivered on main, so
    /// one queue orders them. A task missing from here was stopped and gets
    /// no callback at all (WebKit throws on any callback after stop, and an
    /// Objective-C exception is a crash). An entry exists only while a job
    /// holds the task strongly, so its ObjectIdentifier cannot be reused by
    /// a new task; it is removed on answer or stop, so nothing accumulates.
    private var live: [ObjectIdentifier: StopFlag] = [:]

    /// `decrypt == nil` = the real engine (`serveAttachmentForRender`); tests inject one.
    init(decrypt: Decrypt? = nil) {
        self.decrypt = decrypt ?? serveFromEngine
        super.init()
    }

    /// `e2ee-att://att/<26-char ULID>/<u32>` exactly; anything else nil.
    nonisolated static func parse(_ url: URL) -> (messageId: String, idx: UInt32)? {
        guard let components = URLComponents(url: url.absoluteURL, resolvingAgainstBaseURL: false) else {
            return nil
        }
        guard components.scheme?.lowercased() == attachmentScheme else {
            return nil
        }
        // The raw text must continue `://att/` right after the scheme.
        // URLComponents reports an EMPTY port (`att:/…`) as no port at all,
        // so without this a second spelling of the same id would parse.
        let raw = url.absoluteString
        guard let afterScheme = raw.range(of: "://"),
            raw[afterScheme.upperBound...].hasPrefix("att/")
        else {
            return nil
        }
        // Raw (still percent-encoded) host and path: `%61tt` or an encoded
        // slash must not normalize into a match.
        let host: String?
        if #available(iOS 16.0, *) {
            host = components.encodedHost
        } else {
            host = components.percentEncodedHost
        }
        guard host == "att",
            components.port == nil,
            components.percentEncodedUser == nil,
            components.percentEncodedPassword == nil,
            components.percentEncodedQuery == nil,
            components.percentEncodedFragment == nil
        else {
            return nil
        }
        let segments = components.percentEncodedPath.split(separator: "/", omittingEmptySubsequences: false)
        guard segments.count == 3, segments[0].isEmpty else {
            return nil
        }
        let messageId = String(segments[1])
        guard isUlid(messageId), let idx = parseIndex(segments[2]) else {
            return nil
        }
        return (messageId, idx)
    }

    func webView(_ webView: WKWebView, start urlSchemeTask: WKURLSchemeTask) {
        let id = ObjectIdentifier(urlSchemeTask)
        let flag = StopFlag()
        live[id] = flag

        let request = urlSchemeTask.request
        guard let url = request.url,
            // Only plain loads. HEAD is refused too: answering it would cost
            // a full decrypt just to learn the length.
            (request.httpMethod ?? "GET") == "GET",
            !Self.isTopLevel(request, url),
            let target = Self.parse(url)
        else {
            deliver(notFoundReply(), to: urlSchemeTask, id: id)
            return
        }

        let rangeHeader = request.value(forHTTPHeaderField: "Range")
        let decrypt = self.decrypt
        // @Sendable: the job must not inherit the main-actor isolation of
        // this method, since it runs (and decrypts) on a worker thread.
        attachmentWorkers.submit { @Sendable in
            let reply = prepareReply(
                messageId: target.messageId,
                idx: target.idx,
                rangeHeader: rangeHeader,
                flag: flag,
                decrypt: decrypt
            )
            // Never `.sync`: a worker blocked on main while main waits on
            // the engine is the D1 deadlock.
            DispatchQueue.main.async {
                self.deliver(reply, to: urlSchemeTask, id: id)
            }
        }
    }

    func webView(_ webView: WKWebView, stop urlSchemeTask: WKURLSchemeTask) {
        // A late stop for a task already answered finds nothing: no-op.
        live.removeValue(forKey: ObjectIdentifier(urlSchemeTask))?.stop()
    }

    /// Main only. Re-checks `live` before every callback, so a stop that
    /// lands between two of them (even reentrantly) ends the answer there.
    private func deliver(_ reply: PreparedReply?, to task: WKURLSchemeTask, id: ObjectIdentifier) {
        defer { reply?.wipe() }
        guard live[id] != nil else {
            return
        }
        guard let reply = reply,
            let url = task.request.url,
            let response = HTTPURLResponse(
                url: url,
                statusCode: reply.status,
                httpVersion: "HTTP/1.1",
                headerFields: reply.headers
            )
        else {
            live.removeValue(forKey: id)
            task.didFailWithError(URLError(.resourceUnavailable))
            return
        }
        task.didReceive(response)
        if !reply.body.isEmpty {
            guard live[id] != nil else {
                return
            }
            task.didReceive(reply.body)
        }
        guard live[id] != nil else {
            return
        }
        live.removeValue(forKey: id)
        task.didFinish()
    }

    /// A decrypted attachment is a subresource only (`<img>`/`<video>`
    /// src), never its own page: opened top-level it would be a document
    /// at an origin the app's CSP does not govern.
    private static func isTopLevel(_ request: URLRequest, _ url: URL) -> Bool {
        guard let mainDocument = request.mainDocumentURL else {
            return false
        }
        return mainDocument == url || mainDocument.scheme?.lowercased() == scheme
    }

    /// 26 upper-case Crockford base32 symbols, first one 0-7 (a ULID's
    /// 48-bit timestamp). Stricter than the core's check on purpose: only a
    /// real message id ever reaches the engine.
    private nonisolated static func isUlid(_ s: String) -> Bool {
        let bytes = Array(s.utf8)
        guard bytes.count == 26, let first = bytes.first, first >= 0x30 && first <= 0x37 else {
            return false
        }
        return bytes.allSatisfy { byte in
            if byte >= 0x30 && byte <= 0x39 {
                return true
            }
            guard byte >= 0x41 && byte <= 0x5A else {
                return false
            }
            return byte != UInt8(ascii: "I") && byte != UInt8(ascii: "L")
                && byte != UInt8(ascii: "O") && byte != UInt8(ascii: "U")
        }
    }

    /// Canonical decimal u32: 1-10 ASCII digits, no sign, no leading zero
    /// (one id, one URL).
    private nonisolated static func parseIndex(_ segment: Substring) -> UInt32? {
        let bytes = Array(segment.utf8)
        guard (1...10).contains(bytes.count),
            bytes.allSatisfy({ $0 >= 0x30 && $0 <= 0x39 }),
            bytes.count == 1 || bytes[0] != 0x30
        else {
            return nil
        }
        return UInt32(String(decoding: bytes, as: UTF8.self))
    }
}
