// AttachmentTransfer.swift: native ciphertext upload/fetch to Autumn, and the
// two sanctioned plaintext egresses of a decrypted attachment (copy image,
// save to a user-chosen folder) (IE plan D6).
//
// Ciphertext and plaintext never cross the JS bridge here: the webview only
// names a local id or a (messageId, idx) and gets back a short JSON answer.
// Every function runs on a dedicated non-main thread and blocks on URLSession
// or on main-thread UI through a semaphore (never a synchronous main hop).
// Nothing in this file logs.
import AcutestE2eeBindings
import Foundation
import UIKit
import UniformTypeIdentifiers

enum AttachmentTransfer {
    /// attachmentUpload. Dedicated thread. Resolves the JSON-quoted blob id.
    static func upload(localId: String, url: String, authHeader: String, authValue: String, recipientsJson: String) throws -> String {
        dispatchPrecondition(condition: .notOnQueue(.main))
        let target = try allowedURL(url, blob: false)
        let headerName = try validateAuth(header: authHeader, value: authValue)
        let engine = try E2eeRuntime.shared.engine()
        return try E2eeRuntime.shared.withBackgroundTask("gg.sloga.e2ee.attachment-upload") { () throws -> String in
            dispatchPrecondition(condition: .notOnQueue(.main))
            let ciphertext = try engine.attachmentCiphertext(localId: localId)

            // A random boundary the webview cannot predict, so recipientsJson
            // cannot smuggle in extra multipart parts.
            let boundary = "sloga-e2ee-" + UUID().uuidString.replacingOccurrences(of: "-", with: "").lowercased()
            if recipientsJson.contains(boundary) {
                throw E2eeReject.invalidArgument("recipientsJson")
            }

            var request = autumnRequest(target, authHeader: headerName, authValue: authValue)
            request.httpMethod = "POST"
            request.setValue("multipart/form-data; boundary=\(boundary)", forHTTPHeaderField: "Content-Type")
            let body = multipartBody(boundary: boundary, ciphertext: ciphertext, recipientsJson: recipientsJson)

            guard case .completed(status: 200, body: let response) = perform(request, uploadBody: body, cap: uploadResponseCap),
                  let object = (try? JSONSerialization.jsonObject(with: response)) as? [String: Any],
                  let blobId = object["id"] as? String,
                  !blobId.isEmpty
            else {
                throw uploadFailed
            }

            // The core validates the id's shape; its typed error passes through.
            try engine.attachmentAttachBlob(localId: localId, blobId: blobId)
            return jsonQuote(blobId)
        }
    }

    /// attachmentFetch. Dedicated thread. Resolves the JSON-quoted state: "ready" | "expired" | "failed" | "pending".
    static func fetch(localId: String, url: String, authHeader: String, authValue: String) throws -> String {
        dispatchPrecondition(condition: .notOnQueue(.main))
        let target = try allowedURL(url, blob: true)
        let headerName = try validateAuth(header: authHeader, value: authValue)
        let engine = try E2eeRuntime.shared.engine()
        return try E2eeRuntime.shared.withBackgroundTask("gg.sloga.e2ee.attachment-fetch") { () throws -> String in
            dispatchPrecondition(condition: .notOnQueue(.main))
            var request = autumnRequest(target, authHeader: headerName, authValue: authValue)
            request.httpMethod = "GET"

            switch perform(request, uploadBody: nil, cap: fetchCiphertextCap) {
            case .completed(status: 200, body: let ciphertext):
                do {
                    // The core verifies the envelope digest before persisting;
                    // on a mismatch it has already marked the row failed.
                    try engine.attachmentStore(localId: localId, bytes: ciphertext)
                    return jsonQuote("ready")
                } catch {
                    return jsonQuote("failed")
                }
            case .completed(status: 404, body: _), .completed(status: 410, body: _):
                try engine.attachmentMarkUnavailable(localId: localId, expired: true)
                return jsonQuote("expired")
            default:
                // Other status, network failure, refused redirect or an
                // oversized body: transient, the next sync retries.
                return jsonQuote("pending")
            }
        }
    }

    /// e2ee_attachment_copy_image. Dedicated thread. Resolves "null".
    static func copyImage(messageId: String, idx: UInt32) throws -> String {
        dispatchPrecondition(condition: .notOnQueue(.main))
        let engine = try E2eeRuntime.shared.engine()
        var exported = try E2eeRuntime.shared.withBackgroundTask("gg.sloga.e2ee.attachment-copy") { () throws -> ExportedAttachment in
            dispatchPrecondition(condition: .notOnQueue(.main))
            return try engine.attachmentForExport(messageId: messageId, idx: idx)
        }
        defer { zeroize(&exported.data) }

        guard let type = pasteboardImageType(forFileName: exported.fileName) else {
            throw E2eeReject.invalidArgument("mime")
        }

        // Raw bytes keyed by their type: no UIImage decode of sender-supplied
        // data in this process. Local only (no Universal Clipboard sync to the
        // user's other devices) and gone after two minutes.
        let payload = exported.data
        let identifier = type.identifier
        let lifetime = pasteboardLifetime
        let written = DispatchSemaphore(value: 0)
        DispatchQueue.main.async {
            UIPasteboard.general.setItems(
                [[identifier: payload]],
                options: [.localOnly: true, .expirationDate: Date().addingTimeInterval(lifetime)]
            )
            written.signal()
        }
        written.wait()
        return "null"
    }

    /// e2ee_attachment_save. Dedicated thread; blocks while the folder picker is up.
    /// Resolves "true" (written) or "false" (the user cancelled).
    static func save(messageId: String, idx: UInt32) throws -> String {
        dispatchPrecondition(condition: .notOnQueue(.main))
        // One save at a time: a webview cannot stack save dialogs.
        guard let session = saveGate.enter() else {
            throw busy
        }
        defer { saveGate.leave(session) }
        // Never queue behind, or stack on top of, another consent dialog,
        // and never open over a recovery sheet (its dismissal would take the
        // picker with it and leave this save waiting).
        if NativeConfirmPresenter.shared.isBusy || RecoverySheet.hasActiveFlow {
            throw busy
        }

        let engine = try E2eeRuntime.shared.engine()
        // Metadata only: checks the ids and that the attachment is ready.
        // Nothing is decrypted before the user has chosen a destination.
        let name = try E2eeRuntime.shared.withBackgroundTask("gg.sloga.e2ee.attachment-save") { () throws -> String in
            dispatchPrecondition(condition: .notOnQueue(.main))
            return try engine.attachmentExportName(messageId: messageId, idx: idx)
        }

        // The consent names the file. The webview picks the (messageId, idx),
        // and the folder picker shows no name, so without this a compromised
        // webview could save a different attachment than the one tapped.
        let consent = ConfirmPayload(
            title: "Save attachment?",
            message: "\u{201C}\(name)\u{201D} will be decrypted and saved to the folder you choose.",
            confirmLabel: "Choose folder",
            cancelLabel: "Cancel",
            kind: "info",
            defaultButton: "cancel"
        )
        // A navigation teardown settles the session; checked on both sides
        // of the consent so a torn-down save shows nothing further.
        guard !session.outcome.isSettled,
              try NativeConfirmPresenter.shared.confirm(req: consent),
              !session.outcome.isSettled
        else {
            return "false"
        }

        guard let folder = try pickFolder(session) else {
            return "false"
        }

        try E2eeRuntime.shared.withBackgroundTask("gg.sloga.e2ee.attachment-save") { () throws in
            dispatchPrecondition(condition: .notOnQueue(.main))
            var exported = try engine.attachmentForExport(messageId: messageId, idx: idx)
            defer { zeroize(&exported.data) }
            try writeExclusively(exported.data, named: name, into: folder)
        }
        return "true"
    }

    /// `SlogaAutumnOrigin` from Info.plist (e.g. https://app.sloga.gg/media), validated; nil
    /// when absent or malformed (then every transfer rejects).
    static func pinnedBase() -> URL? {
        // A native build constant, never a webview value: the webview sends
        // the URL and the session token on every call, so a pin it supplied
        // would protect against nothing it controls.
        guard let raw = Bundle.main.object(forInfoDictionaryKey: "SlogaAutumnOrigin") as? String,
              let components = URLComponents(string: raw),
              components.scheme == "https",
              let host = components.percentEncodedHost, !host.isEmpty,
              components.percentEncodedUser == nil,
              components.percentEncodedPassword == nil,
              components.percentEncodedQuery == nil,
              components.percentEncodedFragment == nil,
              isCleanBasePath(components.percentEncodedPath)
        else {
            return nil
        }
        return components.url
    }

    /// Pure: upload (`blob == false`) must be exactly `<base>/e2ee`; fetch (`blob == true`)
    /// exactly `<base>/e2ee/<id>` with one `[A-Za-z0-9_-]{1,128}` segment; same scheme (https),
    /// host and port as `base`; no user, password, query or fragment.
    static func isAllowed(_ url: URL, base: URL, blob: Bool) -> Bool {
        guard let candidate = URLComponents(url: url, resolvingAgainstBaseURL: true),
              let pinned = URLComponents(url: base, resolvingAgainstBaseURL: true),
              candidate.scheme?.lowercased() == "https",
              pinned.scheme?.lowercased() == "https",
              let host = candidate.percentEncodedHost?.lowercased(), !host.isEmpty,
              host == pinned.percentEncodedHost?.lowercased(),
              (candidate.port ?? 443) == (pinned.port ?? 443),
              candidate.percentEncodedUser == nil, candidate.percentEncodedPassword == nil,
              candidate.percentEncodedQuery == nil, candidate.percentEncodedFragment == nil,
              pinned.percentEncodedUser == nil, pinned.percentEncodedPassword == nil,
              pinned.percentEncodedQuery == nil, pinned.percentEncodedFragment == nil
        else {
            return false
        }

        // Compared on the percent-encoded path, so neither `%2F` nor dot
        // segments can reach a different route than the one checked.
        let prefix = pinned.percentEncodedPath + "/e2ee"
        let path = candidate.percentEncodedPath
        guard blob else {
            return path == prefix
        }
        guard path.hasPrefix(prefix + "/") else {
            return false
        }
        let id = path.utf8.dropFirst(prefix.utf8.count + 1)
        return (1...128).contains(id.count) && id.allSatisfy(isBlobIdByte)
    }

    /// TEST SEAM: URLProtocol classes prepended to the ephemeral session configuration.
    static var protocolClassesForTesting: [AnyClass]? = nil

    /// Main-frame load: dismiss an open folder picker as a cancel (the save
    /// resolves "false"), and stop a save between its consent and its picker
    /// from showing one. A write already under way finishes: the user chose
    /// that folder. Any thread; never waits on main.
    static func teardownForNavigation() {
        guard let session = saveGate.current() else {
            return
        }
        // Settle here, not on main, so the waiting save is released at once.
        session.outcome.settle(nil)
        DispatchQueue.main.async {
            MainActor.assumeIsolated {
                session.handle.dismissAndRelease()
            }
        }
    }

    // MARK: - Limits and fixed answers

    /// Upload response: a tiny `{id}`.
    private static let uploadResponseCap = 64 * 1024
    /// The bundled core's one-shot ciphertext ceiling (Android's MAX_ATTACHMENT_CIPHERTEXT).
    private static let fetchCiphertextCap = 21 * 1024 * 1024
    private static let pasteboardLifetime: TimeInterval = 120
    /// A picker nobody answers stops holding the save slot after this long.
    private static let pickerTimeout: TimeInterval = 600
    /// How long the picker waits for the consent alert's dismissal to finish
    /// (40 x 50 ms) before treating the screen as busy.
    private static let pickerPresentAttempts = 40
    private static let pickerPresentRetryDelay: TimeInterval = 0.05
    /// Backstop on top of URLSession's own 300 s resource timeout.
    private static let transferWaitLimit: TimeInterval = 330

    private static let uploadFailed = E2eeReject(json: "{\"type\":\"attachment_unavailable\",\"state\":\"upload_failed\"}")
    private static let busy = E2eeReject(json: "{\"type\":\"busy\"}")
    private static let saveWriteFailed = E2eeReject(json: "{\"type\":\"storage\",\"code\":\"save_write\"}")

    private static let saveGate = SaveGate()

    // MARK: - URL pin and header checks

    private static func allowedURL(_ raw: String, blob: Bool) throws -> URL {
        guard let base = pinnedBase(), let url = URL(string: raw), isAllowed(url, base: base, blob: blob) else {
            throw E2eeReject.invalidArgument("url")
        }
        return url
    }

    /// Empty (origin only) or `/seg(/seg)*` of unreserved characters, no dot
    /// segments, no trailing slash.
    private static func isCleanBasePath(_ path: String) -> Bool {
        if path.isEmpty {
            return true
        }
        guard path.hasPrefix("/"), !path.hasSuffix("/") else {
            return false
        }
        for segment in path.utf8.dropFirst().split(separator: UInt8(ascii: "/"), omittingEmptySubsequences: false) {
            let isDots = segment.allSatisfy { $0 == UInt8(ascii: ".") }
            if segment.isEmpty || isDots || !segment.allSatisfy(isUnreservedByte) {
                return false
            }
        }
        return true
    }

    private static func isBlobIdByte(_ byte: UInt8) -> Bool {
        isAsciiAlphanumeric(byte) || byte == UInt8(ascii: "-") || byte == UInt8(ascii: "_")
    }

    private static func isUnreservedByte(_ byte: UInt8) -> Bool {
        isBlobIdByte(byte) || byte == UInt8(ascii: ".") || byte == UInt8(ascii: "~")
    }

    private static func isAsciiAlphanumeric(_ byte: UInt8) -> Bool {
        (byte >= 0x30 && byte <= 0x39) || (byte >= 0x41 && byte <= 0x5A) || (byte >= 0x61 && byte <= 0x7A)
    }

    /// The only names stoat.js's `client.authenticationHeader` returns
    /// (stoat.js src/Client.ts): a user session or a bot token.
    private static let authHeaderNames = ["X-Session-Token", "X-Bot-Token"]

    /// The header name must be one of `authHeaderNames` (ASCII,
    /// case-insensitive; the canonical spelling is returned and sent), so a
    /// compromised webview cannot aim the session token at `Host`, `Cookie`,
    /// `Authorization` or any other header. The value must not be able to
    /// split the request (CR, LF, NUL).
    private static func validateAuth(header: String, value: String) throws -> String {
        let name = header.utf8
        // ASCII first: `lowercased()` folds some non-ASCII letters (the
        // Kelvin sign) onto ASCII ones.
        guard (1...64).contains(name.count),
              name.allSatisfy({ isAsciiAlphanumeric($0) || $0 == UInt8(ascii: "-") }),
              let canonical = authHeaderNames.first(where: { $0.lowercased() == header.lowercased() })
        else {
            throw E2eeReject.invalidArgument("authHeader")
        }
        guard !value.utf8.contains(where: { $0 == 0x0D || $0 == 0x0A || $0 == 0x00 }) else {
            throw E2eeReject.invalidArgument("authValue")
        }
        return canonical
    }

    // MARK: - HTTP

    private static func autumnRequest(_ url: URL, authHeader: String, authValue: String) -> URLRequest {
        var request = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 30)
        request.httpShouldHandleCookies = false
        request.setValue(authValue, forHTTPHeaderField: authHeader)
        return request
    }

    /// Byte-for-byte Android's multipart shape: a `file` part named "blob"
    /// (octet-stream) followed by the `recipients` part.
    private static func multipartBody(boundary: String, ciphertext: Data, recipientsJson: String) -> Data {
        var body = Data()
        body.reserveCapacity(ciphertext.count + recipientsJson.utf8.count + 4 * boundary.utf8.count + 256)
        body.append(contentsOf: Array("--\(boundary)\r\n".utf8))
        body.append(contentsOf: Array("Content-Disposition: form-data; name=\"file\"; filename=\"blob\"\r\n".utf8))
        body.append(contentsOf: Array("Content-Type: application/octet-stream\r\n\r\n".utf8))
        body.append(ciphertext)
        body.append(contentsOf: Array("\r\n--\(boundary)\r\n".utf8))
        body.append(contentsOf: Array("Content-Disposition: form-data; name=\"recipients\"\r\n\r\n".utf8))
        body.append(contentsOf: Array(recipientsJson.utf8))
        body.append(contentsOf: Array("\r\n--\(boundary)--\r\n".utf8))
        return body
    }

    /// One request on a fresh ephemeral session that is torn down afterwards:
    /// no cookies, no URL cache, no credential store, nothing persisted.
    private static func perform(_ request: URLRequest, uploadBody: Data?, cap: Int) -> TransferOutcome {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.urlCache = nil
        configuration.httpCookieStorage = nil
        configuration.httpShouldSetCookies = false
        configuration.httpCookieAcceptPolicy = .never
        configuration.urlCredentialStorage = nil
        configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
        configuration.timeoutIntervalForRequest = 30
        configuration.timeoutIntervalForResource = 300
        configuration.tlsMinimumSupportedProtocolVersion = .TLSv12
        if let testing = protocolClassesForTesting {
            configuration.protocolClasses = testing + (configuration.protocolClasses ?? [])
        }

        let delegate = TransferDelegate(cap: cap)
        let session = URLSession(configuration: configuration, delegate: delegate, delegateQueue: nil)
        // The session retains its delegate until invalidated.
        defer { session.invalidateAndCancel() }

        let task: URLSessionTask
        if let uploadBody = uploadBody {
            task = session.uploadTask(with: request, from: uploadBody)
        } else {
            task = session.dataTask(with: request)
        }
        task.resume()

        guard delegate.wait(timeout: transferWaitLimit) else {
            task.cancel()
            return .failed
        }
        return delegate.outcome()
    }

    // MARK: - Copy image

    /// The pasteboard type for an image file name, or nil. SVG is refused: it
    /// is scriptable, and the render path degrades it for the same reason.
    private static func pasteboardImageType(forFileName fileName: String) -> UTType? {
        let ext = (fileName as NSString).pathExtension
        guard !ext.isEmpty,
              let type = UTType(filenameExtension: ext),
              type.conforms(to: .image),
              !type.conforms(to: .svg)
        else {
            return nil
        }
        return type
    }

    // MARK: - Save

    /// Shows the folder picker and waits for it. nil = cancelled, torn down or
    /// unanswered. Throws `busy` when another dialog is up, `crypto_failure`
    /// when the picker could not be presented.
    private static func pickFolder(_ session: SaveSession) throws -> URL? {
        let outcome = session.outcome
        let handle = session.handle

        var presentation = PickerPresentation.retry
        for _ in 0..<pickerPresentAttempts {
            // Checked again here: a consent request may be queued but not yet
            // on screen, and the picker must not hide it.
            if NativeConfirmPresenter.shared.isBusy || RecoverySheet.hasActiveFlow {
                throw busy
            }
            let shown = DispatchSemaphore(value: 0)
            DispatchQueue.main.async {
                MainActor.assumeIsolated {
                    handle.present(outcome: outcome)
                }
                shown.signal()
            }
            shown.wait()
            presentation = handle.presentation
            guard presentation == .retry else {
                break
            }
            // Our own consent alert is still animating out. Wait here, off
            // main, and look again.
            Thread.sleep(forTimeInterval: pickerPresentRetryDelay)
        }

        switch presentation {
        case .presented:
            break
        case .cancelled:
            return nil
        case .busy, .retry:
            throw busy
        case .failed:
            throw E2eeReject.cryptoFailure
        }

        let answer = outcome.wait(timeout: pickerTimeout)
        // Settle first so a pick that lands after the timeout is ignored.
        outcome.settle(nil)
        DispatchQueue.main.async {
            MainActor.assumeIsolated {
                handle.dismissAndRelease()
            }
        }
        return answer
    }

    /// Writes `data` as a NEW file in `folder`: never overwrites, never
    /// follows an existing name, and removes its own partial file on failure.
    private static func writeExclusively(_ data: Data, named rawName: String, into folder: URL) throws {
        let scoped = folder.startAccessingSecurityScopedResource()
        defer {
            if scoped {
                folder.stopAccessingSecurityScopedResource()
            }
        }

        let coordinator = NSFileCoordinator(filePresenter: nil)
        var coordinationError: NSError?
        var written = false
        coordinator.coordinate(writingItemAt: folder, options: [], error: &coordinationError) { directory in
            written = writeUnique(data, named: leafName(rawName), in: directory)
        }
        guard coordinationError == nil, written else {
            throw saveWriteFailed
        }
    }

    private static func writeUnique(_ data: Data, named name: String, in directory: URL) -> Bool {
        guard (try? directory.resourceValues(forKeys: [.isDirectoryKey]))?.isDirectory == true else {
            return false
        }
        let stem = (name as NSString).deletingPathExtension
        let ext = (name as NSString).pathExtension
        let fileManager = FileManager.default

        for attempt in 1...100 {
            let candidateName: String
            if attempt == 1 {
                candidateName = name
            } else if ext.isEmpty {
                candidateName = "\(stem) (\(attempt))"
            } else {
                candidateName = "\(stem) (\(attempt)).\(ext)"
            }
            let candidate = directory.appendingPathComponent(candidateName, isDirectory: false)

            // Claim the name with an exclusive create (O_EXCL): it fails if
            // anything, a link included, already sits there.
            do {
                try Data().write(to: candidate, options: [.withoutOverwriting])
            } catch let error as CocoaError where error.code == .fileWriteFileExists {
                continue
            } catch {
                if fileManager.fileExists(atPath: candidate.path) {
                    continue
                }
                return false
            }

            // The file is ours now, so a failed fill may delete it: no
            // partial plaintext is left at the destination.
            do {
                let handle = try FileHandle(forWritingTo: candidate)
                defer { try? handle.close() }
                try handle.write(contentsOf: data)
                try handle.synchronize()
                return true
            } catch {
                try? fileManager.removeItem(at: candidate)
                return false
            }
        }
        return false
    }

    /// The core already sanitized the name; this only re-asserts that it is a
    /// single, visible path component.
    private static func leafName(_ raw: String) -> String {
        var cleaned = String(String.UnicodeScalarView(raw.unicodeScalars.map { scalar -> Unicode.Scalar in
            switch scalar {
            case "/", "\\", ":":
                return "_"
            default:
                return (scalar.value < 0x20 || scalar.value == 0x7F) ? "_" : scalar
            }
        }))
        cleaned = cleaned.trimmingCharacters(in: CharacterSet(charactersIn: " ."))
        while cleaned.utf8.count > 200 {
            cleaned.removeFirst()
        }
        cleaned = cleaned.trimmingCharacters(in: CharacterSet(charactersIn: " ."))
        return cleaned.isEmpty ? "attachment" : cleaned
    }
}

// MARK: - URLSession delegate

/// How one Autumn request ended.
private enum TransferOutcome {
    /// The server answered. `body` is only read for a 200; any other status
    /// is cancelled as soon as its status line arrives.
    case completed(status: Int, body: Data)
    /// Network error, timeout, non-HTTP response or a body over the cap.
    case failed
}

/// Accumulates one response under a hard cap. Redirects are refused because
/// URLSession would otherwise follow them and forward the session token.
private final class TransferDelegate: NSObject, URLSessionDataDelegate, @unchecked Sendable {
    private let cap: Int
    private let lock = NSLock()
    private let done = DispatchSemaphore(value: 0)
    private var status: Int?
    private var body = Data()
    private var overCap = false
    private var finished = false
    private var transportError = false

    init(cap: Int) {
        self.cap = cap
    }

    func urlSession(
        _ session: URLSession,
        task: URLSessionTask,
        willPerformHTTPRedirection response: HTTPURLResponse,
        newRequest request: URLRequest,
        completionHandler: @escaping @Sendable (URLRequest?) -> Void
    ) {
        completionHandler(nil)
    }

    func urlSession(
        _ session: URLSession,
        dataTask: URLSessionDataTask,
        didReceive response: URLResponse,
        completionHandler: @escaping @Sendable (URLSession.ResponseDisposition) -> Void
    ) {
        guard let http = response as? HTTPURLResponse else {
            completionHandler(.cancel)
            return
        }
        let ok = http.statusCode == 200
        let declaredTooLarge = response.expectedContentLength > Int64(cap)
        lock.lock()
        status = http.statusCode
        if ok && declaredTooLarge {
            overCap = true
        }
        lock.unlock()
        // Only a 200 body is ever read; anything else needs just its status.
        completionHandler(ok && !declaredTooLarge ? .allow : .cancel)
    }

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
        lock.lock()
        if overCap {
            lock.unlock()
            return
        }
        if data.count > cap - body.count {
            overCap = true
            body = Data()
            lock.unlock()
            dataTask.cancel()
            return
        }
        body.append(data)
        lock.unlock()
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        lock.lock()
        let first = !finished
        if first {
            finished = true
            transportError = error != nil
        }
        lock.unlock()
        if first {
            done.signal()
        }
    }

    func wait(timeout: TimeInterval) -> Bool {
        done.wait(timeout: .now() + timeout) == .success
    }

    func outcome() -> TransferOutcome {
        lock.lock()
        defer { lock.unlock() }
        guard finished, !overCap, let status = status else {
            return .failed
        }
        if status == 200 {
            return transportError ? .failed : .completed(status: 200, body: body)
        }
        // Cancelled on purpose once the status line arrived.
        return .completed(status: status, body: Data())
    }
}

// MARK: - Save helpers

/// One save in flight: its picker answer and the picker itself, reachable
/// by `teardownForNavigation`.
private final class SaveSession: @unchecked Sendable {
    let outcome = PickerOutcome()
    let handle = PickerHandle()
}

/// Allows one save (one consent, one folder picker) at a time.
private final class SaveGate: @unchecked Sendable {
    private let lock = NSLock()
    private var session: SaveSession?

    /// The new session, or nil when a save is already in flight.
    func enter() -> SaveSession? {
        lock.lock()
        defer { lock.unlock() }
        if session != nil {
            return nil
        }
        let fresh = SaveSession()
        session = fresh
        return fresh
    }

    func leave(_ finished: SaveSession) {
        lock.lock()
        if session === finished {
            session = nil
        }
        lock.unlock()
    }

    func current() -> SaveSession? {
        lock.lock()
        defer { lock.unlock() }
        return session
    }
}

/// The picker's answer, settled exactly once (pick, cancel, teardown or
/// timeout).
private final class PickerOutcome: @unchecked Sendable {
    private let condition = NSCondition()
    private var settled = false
    private var folder: URL?

    func settle(_ url: URL?) {
        condition.lock()
        defer { condition.unlock() }
        guard !settled else {
            return
        }
        settled = true
        folder = url
        condition.broadcast()
    }

    var isSettled: Bool {
        condition.lock()
        defer { condition.unlock() }
        return settled
    }

    /// The picked folder; nil when cancelled or not answered in time.
    func wait(timeout: TimeInterval) -> URL? {
        let deadline = Date().addingTimeInterval(timeout)
        condition.lock()
        defer { condition.unlock() }
        while !settled {
            if !condition.wait(until: deadline) {
                break
            }
        }
        return settled ? folder : nil
    }
}

/// How one attempt to show the folder picker went.
private enum PickerPresentation: Equatable {
    case presented
    /// The save was torn down (navigation) before the picker showed.
    case cancelled
    /// Someone else's alert is on screen.
    case busy
    /// A transition (our consent alert leaving) is still running: try again.
    case retry
    case failed
}

/// Owns the picker and its (weakly referenced) delegate while it is up.
/// Properties are touched on main only; `presentation` is written on main
/// before the presenting semaphore is signalled and read after it.
private final class PickerHandle: @unchecked Sendable {
    private(set) var presentation = PickerPresentation.retry
    private var controller: UIDocumentPickerViewController?
    private var delegate: FolderPickerDelegate?

    @MainActor
    func present(outcome: PickerOutcome) {
        presentation = attemptPresent(outcome: outcome)
    }

    @MainActor
    private func attemptPresent(outcome: PickerOutcome) -> PickerPresentation {
        // Torn down while this block was queued: show nothing.
        if outcome.isSettled {
            return .cancelled
        }
        guard let top = NativeConfirmPresenter.topMostViewController() else {
            return .failed
        }
        // Never stack on an alert: a picker over a consent dialog hides it.
        // Our own consent alert may still be on its way out.
        if let alert = top as? UIAlertController {
            return alert.isBeingDismissed ? .retry : .busy
        }
        if top.isBeingPresented || top.isBeingDismissed {
            return .retry
        }
        guard top.viewIfLoaded?.window != nil else {
            return .failed
        }
        // Folders only: the user picks WHERE, and only then is anything
        // decrypted and written there. No plaintext temp file ever exists.
        let picker = UIDocumentPickerViewController(forOpeningContentTypes: [.folder])
        picker.allowsMultipleSelection = false
        // No swipe-to-dismiss: the only ways out are Open and Cancel, both
        // of which answer the delegate.
        picker.isModalInPresentation = true
        let pickerDelegate = FolderPickerDelegate(outcome: outcome)
        picker.delegate = pickerDelegate
        top.present(picker, animated: true)
        guard top.presentedViewController === picker || picker.presentingViewController != nil else {
            return .failed
        }
        controller = picker
        delegate = pickerDelegate
        return .presented
    }

    @MainActor
    func dismissAndRelease() {
        if let picker = controller, picker.presentingViewController != nil, !picker.isBeingDismissed {
            picker.dismiss(animated: true)
        }
        controller = nil
        delegate = nil
    }
}

@MainActor
private final class FolderPickerDelegate: NSObject, UIDocumentPickerDelegate {
    private let outcome: PickerOutcome

    init(outcome: PickerOutcome) {
        self.outcome = outcome
    }

    func documentPicker(_ controller: UIDocumentPickerViewController, didPickDocumentsAt urls: [URL]) {
        outcome.settle(urls.count == 1 ? urls.first : nil)
    }

    func documentPickerWasCancelled(_ controller: UIDocumentPickerViewController) {
        outcome.settle(nil)
    }
}
