// StoreTests.swift (G9, lane T5): where the E2EE store lives and how it is
// kept out of backups (IE plan D4), plus the shared pieces in Support.swift
// (reject payloads, JSON quoting, the engine threads, the runtime).
//
// These tests read the app's REAL store directory (Application Support/e2ee),
// because that path is the code under test. They never delete anything in it
// and never construct an engine on it. The only write to it is the backup flag,
// cleared and restored by one Simulator-only test.
//
// Every check runs against a known-bad subject too (the negative controls in
// each test), so a checker that accepts everything fails here. `t5Control`
// flips every test to its known-bad subject; the control run sets it to true
// and every test must then fail.
import AcutestE2eeBindings
import Darwin
import Foundation
import XCTest
@testable import SlogaE2ee

private let t5Control = false

/// The real subject normally, the known-bad one in the control run.
private func subject<T>(_ real: @autoclosure () throws -> T, bad: @autoclosure () throws -> T) rethrows -> T {
    try t5Control ? bad() : real()
}

/// Written as a literal, not read from `engineThreadStackSize`, so a smaller
/// module constant is caught.
private let eightMiB = 8 * 1024 * 1024

private enum T5Failure: Error {
    case timedOut
}

/// Hands a closure to GCD or Thread without Sendable diagnostics; every value
/// the tests share across threads sits behind `Locked`.
private struct UncheckedSendable<Value>: @unchecked Sendable {
    let value: Value
}

private final class Locked<Value>: @unchecked Sendable {
    private let lock = NSLock()
    private var value: Value

    init(_ value: Value) {
        self.value = value
    }

    @discardableResult
    func update<R>(_ body: (inout Value) -> R) -> R {
        lock.lock()
        defer { lock.unlock() }
        return body(&value)
    }

    var snapshot: Value {
        update { $0 }
    }
}

private func onGlobalQueue(_ body: @escaping () -> Void) {
    let work = UncheckedSendable(value: body)
    DispatchQueue.global(qos: .userInitiated).async { work.value() }
}

private func onQueue(_ queue: DispatchQueue, _ body: @escaping () -> Void) {
    let work = UncheckedSendable(value: body)
    queue.async { work.value() }
}

// MARK: - File-system probes (read-only unless named write*)

/// The file type at `path` without following a symlink.
private func lstatKind(_ path: String) -> mode_t? {
    var info = stat()
    guard lstat(path, &info) == 0 else {
        return nil
    }
    return info.st_mode & S_IFMT
}

private func inodeOf(_ path: String) -> ino_t? {
    var info = stat()
    guard lstat(path, &info) == 0 else {
        return nil
    }
    return info.st_ino
}

/// Reads the backup flag through a NEW URL instance every time: resource
/// values are cached per URL object, so reusing one would read back the
/// value it cached, not what is on disk.
private func readExcluded(_ path: String) throws -> Bool? {
    let url = URL(fileURLWithPath: path, isDirectory: true)
    return try url.resourceValues(forKeys: [.isExcludedFromBackupKey]).isExcludedFromBackup
}

private func writeExcluded(_ path: String, _ excluded: Bool) throws {
    var url = URL(fileURLWithPath: path, isDirectory: true)
    var values = URLResourceValues()
    values.isExcludedFromBackup = excluded
    try url.setResourceValues(values)
}

private func protectionOf(_ attributes: [FileAttributeKey: Any]) -> FileProtectionType? {
    if let type = attributes[.protectionKey] as? FileProtectionType {
        return type
    }
    if let raw = attributes[.protectionKey] as? String {
        return FileProtectionType(rawValue: raw)
    }
    return nil
}

/// Every regular file below `root`, descending only into real directories
/// (lstat), the same walk shape the store uses. Read-only.
private func regularFiles(under root: String) -> [String] {
    var found: [String] = []
    var pending = [root]
    while let directory = pending.popLast() {
        guard let names = try? FileManager.default.contentsOfDirectory(atPath: directory) else {
            continue
        }
        for name in names {
            let path = (directory as NSString).appendingPathComponent(name)
            switch lstatKind(path) {
            case S_IFDIR?: pending.append(path)
            case S_IFREG?: found.append(path)
            default: continue
            }
        }
    }
    return found
}

// MARK: - Checkers (each returns what is wrong; empty = pass)

private func realDirectoryProblems(_ path: String, label: String) -> [String] {
    let kind = lstatKind(path)
    if kind == S_IFDIR {
        return []
    }
    return ["\(label) is not a real directory (lstat type \(kind.map { String($0, radix: 8) } ?? "absent"))"]
}

private func isUnder(_ path: String, _ root: String) -> Bool {
    path == root || path.hasPrefix(root.hasSuffix("/") ? root : root + "/")
}

/// Documents (backed up, visible in Files), Caches and tmp (purged by iOS; an
/// emptied store reads as never-provisioned).
private func forbiddenRoots() -> [(label: String, path: String)] {
    let fm = FileManager.default
    var roots: [(label: String, path: String)] = []
    if let documents = fm.urls(for: .documentDirectory, in: .userDomainMask).first {
        roots.append(("Documents", documents.standardizedFileURL.path))
    }
    if let caches = fm.urls(for: .cachesDirectory, in: .userDomainMask).first {
        roots.append(("Caches", caches.standardizedFileURL.path))
    }
    roots.append(("tmp", fm.temporaryDirectory.standardizedFileURL.path))
    roots.append(("tmp", URL(fileURLWithPath: NSTemporaryDirectory(), isDirectory: true).standardizedFileURL.path))
    return roots
}

/// `<Application Support>/e2ee`, derived independently of the code under test
/// (NSSearchPath, not FileManager.url(for:)), cross-checked against the
/// container's Library.
private func expectedStorePath() -> String? {
    guard let support = NSSearchPathForDirectoriesInDomains(.applicationSupportDirectory, .userDomainMask, true).first
    else {
        return nil
    }
    let expected = URL(fileURLWithPath: support, isDirectory: true)
        .appendingPathComponent("e2ee", isDirectory: true).standardizedFileURL.path
    let fromHome = URL(fileURLWithPath: NSHomeDirectory(), isDirectory: true)
        .appendingPathComponent("Library/Application Support/e2ee", isDirectory: true).standardizedFileURL.path
    return expected == fromHome ? expected : nil
}

private func storeLocationProblems(_ url: URL) -> [String] {
    var problems: [String] = []
    if !url.isFileURL {
        problems.append("not a file URL")
    }
    let path = url.standardizedFileURL.path
    if !path.hasPrefix("/") {
        problems.append("not absolute")
    }
    if url.path != path {
        problems.append("returned path is not standardized")
    }
    if let expected = expectedStorePath() {
        if path != expected {
            problems.append("not <Application Support>/e2ee")
        }
    } else {
        problems.append("cannot derive <Application Support>/e2ee independently")
    }
    let resolved = url.resolvingSymlinksInPath().standardizedFileURL.path
    for root in forbiddenRoots() where isUnder(path, root.path) || isUnder(resolved, root.path) {
        problems.append("under \(root.label)")
    }
    problems += realDirectoryProblems(path, label: "store dir")
    problems += realDirectoryProblems((path as NSString).appendingPathComponent("attachments"), label: "attachments")
    return problems
}

/// On the Simulator data protection is not enforced and the attribute reads
/// nil; the class itself is proven on device (leg L-F). A value that IS
/// reported must be the store's class, here and on device.
private func protectionProblems(_ type: FileProtectionType?) -> [String] {
    #if targetEnvironment(simulator)
    if type == nil {
        return []
    }
    #endif
    if type == .completeUntilFirstUserAuthentication {
        return []
    }
    return ["protection class is \(type?.rawValue ?? "nil")"]
}

private struct JobSample {
    let index: Int
    let onMain: Bool
    let pthreadStack: Int
    let threadStack: Int
    let threadName: String?
    let thread: ObjectIdentifier
}

private func probeThread(_ index: Int) -> JobSample {
    JobSample(
        index: index,
        onMain: Thread.isMainThread,
        pthreadStack: pthread_get_stacksize_np(pthread_self()),
        threadStack: Thread.current.stackSize,
        threadName: Thread.current.name,
        thread: ObjectIdentifier(Thread.current)
    )
}

private struct Flight {
    var now = 0
    var max = 0
}

/// One serial executor: submission order, one thread with the given name,
/// never main, never two jobs at once, 8 MiB stacks.
private func serialRunProblems(_ samples: [JobSample], count: Int, name: String, maxInFlight: Int) -> [String] {
    var problems: [String] = []
    if samples.map(\.index) != Array(0..<count) {
        problems.append("jobs did not run in submission order")
    }
    if samples.contains(where: \.onMain) {
        problems.append("a job ran on the main thread")
    }
    if let low = samples.map(\.pthreadStack).min(), low < eightMiB {
        problems.append("pthread stack \(low) < 8 MiB")
    }
    if let low = samples.map(\.threadStack).min(), low < eightMiB {
        problems.append("Thread.stackSize \(low) < 8 MiB")
    }
    let threads = Set(samples.map(\.thread)).count
    if threads != 1 {
        problems.append("jobs ran on \(threads) threads, expected 1")
    }
    if samples.contains(where: { $0.threadName != name }) {
        problems.append("a job ran on a thread not named \(name)")
    }
    if maxInFlight != 1 {
        problems.append("\(maxInFlight) jobs ran at once")
    }
    return problems
}

private struct T5PlainError: Error {}

private let cryptoFailureJson = "{\"type\":\"crypto_failure\"}"

/// Each error a plugin path can throw, and the reject payload it must map to.
private func rejectMappingProblems(_ map: (Error) -> String) -> [String] {
    let coreLocked = "{\"type\":\"locked\"}"
    let coreArgument = "{\"type\":\"invalid_argument\",\"field\":\"conversationId\"}"
    let cases: [(label: String, error: Error, expected: String)] = [
        ("core JSON", E2eeError.Failure(message: coreLocked), coreLocked),
        ("core JSON with field", E2eeError.Failure(message: coreArgument), coreArgument),
        ("core non-JSON text", E2eeError.Failure(message: "store error at /var/mobile/x"), cryptoFailureJson),
        ("core empty message", E2eeError.Failure(message: ""), cryptoFailureJson),
        ("core JSON after a space", E2eeError.Failure(message: " " + coreLocked), cryptoFailureJson),
        ("core JSON array", E2eeError.Failure(message: "[\"locked\"]"), cryptoFailureJson),
        ("confirm error", ConfirmError.Failed, cryptoFailureJson),
        (
            "NSError with a path",
            NSError(domain: NSCocoaErrorDomain, code: 4, userInfo: [NSFilePathErrorKey: "/private/x"]),
            cryptoFailureJson
        ),
        ("CocoaError", CocoaError(.fileNoSuchFile), cryptoFailureJson),
        ("URLError", URLError(.badURL), cryptoFailureJson),
        ("plain Swift error", T5PlainError(), cryptoFailureJson),
        ("reject invalid_argument", E2eeReject.invalidArgument("messageId"),
         "{\"type\":\"invalid_argument\",\"field\":\"messageId\"}"),
        ("reject declined", E2eeReject.declined, "{\"type\":\"declined\"}"),
        ("reject crypto_failure", E2eeReject.cryptoFailure, cryptoFailureJson),
        ("reject custom", E2eeReject(json: "{\"type\":\"busy\"}"), "{\"type\":\"busy\"}"),
    ]
    return cases.compactMap { item in
        let got = map(item.error)
        return got == item.expected ? nil : "\(item.label): got \(got)"
    }
}

private func parseObject(_ json: String) -> [String: Any]? {
    (try? JSONSerialization.jsonObject(with: Data(json.utf8))) as? [String: Any]
}

private func scalars(_ s: String) -> [Unicode.Scalar] {
    Array(s.unicodeScalars)
}

private func stringFrom(_ values: [UInt32]) -> String {
    var s = ""
    s.unicodeScalars.append(contentsOf: values.compactMap { Unicode.Scalar($0) })
    return s
}

private let awkwardFields: [String] = [
    "messageId",
    "",
    "a\"b",
    "back\\slash",
    "new\nline",
    "tab\tand\rreturn",
    "\u{0}nul",
    "\"\\\n\r\t\u{1}\u{1F}",
    "\"},\"type\":\"declined",
    "caf\u{E9} \u{4E2D} \u{1F642} \u{2028}",
]

private func invalidArgumentProblems(_ make: (String) -> String) -> [String] {
    var problems: [String] = []
    for field in awkwardFields {
        guard let object = parseObject(make(field)) else {
            problems.append("not valid JSON for field \(scalars(field))")
            continue
        }
        if Set(object.keys) != ["type", "field"] {
            problems.append("keys \(object.keys.sorted()) for field \(scalars(field))")
        }
        if object["type"] as? String != "invalid_argument" {
            problems.append("type is not invalid_argument for field \(scalars(field))")
        }
        if (object["field"] as? String).map(scalars) != scalars(field) {
            problems.append("field did not round-trip: \(scalars(field))")
        }
    }
    return problems
}

private func jsonQuoteInputs() -> [String] {
    var inputs = [
        "",
        "plain",
        stringFrom(Array(UInt32(0)..<0x20)),
        "\"",
        "\\",
        "/",
        "\u{7F}",
        "a\"b\\c\nd\re\tf",
        "caf\u{E9}",
        "cafe\u{301}",
        "\u{4E2D}\u{6587}",
        "\u{1F642}\u{1F3F3}\u{FE0F}\u{200D}\u{1F308}",
        "\u{2028}\u{2029}",
        "\u{FEFF}bom",
        "mid\u{FEFF}bom",
        "</script><!--",
    ]
    inputs += (UInt32(0)..<0x20).map { stringFrom([$0]) }
    return inputs
}

private func jsonQuoteProblems(_ quote: (String) -> String) -> [String] {
    var problems: [String] = []
    for input in jsonQuoteInputs() {
        let quoted = quote(input)
        let out = scalars(quoted)
        if out.count < 2 || out.first != "\"" || out.last != "\"" {
            problems.append("not wrapped in quotes: \(scalars(input))")
        }
        if out.contains(where: { $0.value < 0x20 }) {
            problems.append("raw control character in output for \(scalars(input))")
        }
        let document = Data("[\(quoted)]".utf8)
        // JSONSerialization drops a U+FEFF that STARTS a string value (its
        // NSString treats it as a byte-order mark), even for hand-written JSON
        // that never went through jsonQuote. JS JSON.parse keeps it, and so
        // does JSONDecoder, which checks every input below.
        if input.unicodeScalars.first != "\u{FEFF}" {
            let parsed = (try? JSONSerialization.jsonObject(with: document)) as? [String]
            if parsed?.count != 1 || parsed.map({ scalars($0[0]) }) != scalars(input) {
                problems.append("did not round-trip through JSONSerialization: \(scalars(input))")
            }
        }
        let decoded = try? JSONDecoder().decode([String].self, from: document)
        if decoded?.count != 1 || decoded.map({ scalars($0[0]) }) != scalars(input) {
            problems.append("did not round-trip through JSONDecoder: \(scalars(input))")
        }
    }
    return problems
}

// MARK: - Tests

final class StoreTests: XCTestCase {
    /// Runs `body` on a plain background thread and waits for it: the store
    /// work is documented for non-main threads.
    private func offMain<T>(_ body: @escaping () throws -> T) throws -> T {
        let box = Locked<Result<T, Error>?>(nil)
        let done = expectation(description: "T5 off-main body")
        let work = UncheckedSendable(value: {
            let result = Result { try body() }
            box.update { $0 = result }
            done.fulfill()
        })
        let thread = Thread { work.value() }
        thread.stackSize = eightMiB
        thread.start()
        wait(for: [done], timeout: 30)
        guard let result = box.snapshot else {
            throw T5Failure.timedOut
        }
        return try result.get()
    }

    private func prepareStore() throws -> URL {
        try offMain { try E2eeStore.prepareStoreDirectory() }
    }

    private func makeTempDir() throws -> URL {
        let dir = FileManager.default.temporaryDirectory
            .appendingPathComponent("T5-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: false)
        addTeardownBlock {
            try? FileManager.default.removeItem(at: dir)
        }
        return dir
    }

    // MARK: D4 location

    func testStoreDirectoryIsApplicationSupportE2eeRealAbsoluteAndHasAttachments() throws {
        let store = try prepareStore()
        let documents = try XCTUnwrap(FileManager.default.urls(for: .documentDirectory, in: .userDomainMask).first)
        let checked = subject(store, bad: documents.appendingPathComponent("e2ee", isDirectory: true))
        XCTAssertEqual(storeLocationProblems(checked), [])

        // Negative controls: the checker must refuse each forbidden root, a
        // sibling of the right name, and a symlink standing in for a directory.
        for root in forbiddenRoots() {
            let candidate = URL(fileURLWithPath: root.path, isDirectory: true)
                .appendingPathComponent("e2ee", isDirectory: true)
            XCTAssertTrue(storeLocationProblems(candidate).contains("under \(root.label)"), root.label)
        }
        let sibling = store.deletingLastPathComponent().appendingPathComponent("e2ee-other", isDirectory: true)
        XCTAssertTrue(storeLocationProblems(sibling).contains("not <Application Support>/e2ee"))

        let temp = try makeTempDir()
        let real = temp.appendingPathComponent("real", isDirectory: true)
        let link = temp.appendingPathComponent("link", isDirectory: true)
        try FileManager.default.createDirectory(at: real, withIntermediateDirectories: false)
        try FileManager.default.createSymbolicLink(at: link, withDestinationURL: real)
        XCTAssertEqual(realDirectoryProblems(real.path, label: "real"), [])
        XCTAssertFalse(realDirectoryProblems(link.path, label: "link").isEmpty, "a symlink must not pass as a directory")
    }

    func testPrepareStoreDirectoryIsIdempotent() throws {
        let first = try prepareStore()
        let firstInodes = [inodeOf(first.path), inodeOf(first.appendingPathComponent("attachments").path)]
        let temp = try makeTempDir()
        let second = try subject(prepareStore(), bad: temp)
        let third = try prepareStore()
        let secondInodes = [inodeOf(second.path), inodeOf(second.appendingPathComponent("attachments").path)]

        XCTAssertEqual(second, first)
        XCTAssertEqual(third, first)
        XCTAssertFalse(firstInodes.contains(nil))
        // Same inodes: a repeat call reuses the store, it does not recreate it.
        XCTAssertEqual(secondInodes, firstInodes)
        XCTAssertEqual(storeLocationProblems(third), [])
        XCTAssertEqual(try readExcluded(third.path), true)
    }

    // MARK: D4 backup exclusion

    func testStoreDirectoryReadsExcludedFromBackupOnAFreshURL() throws {
        let store = try prepareStore()
        let temp = try makeTempDir()
        let checked = subject(store, bad: temp)
        XCTAssertEqual(try readExcluded(checked.path), true)

        // Negative control: a directory nobody excluded reads false, so the
        // reader is not answering true for everything.
        XCTAssertEqual(try readExcluded(temp.path), false)
    }

    func testPrepareReassertsBackupExclusionOnEveryCall() throws {
        #if !targetEnvironment(simulator)
        throw XCTSkip("clears the real store's backup flag for a moment; Simulator only")
        #else
        let store = try prepareStore()
        // The Simulator has no backup, and the flag is put back below whatever
        // happens, so clearing it briefly exposes nothing.
        defer { try? writeExcluded(store.path, true) }
        try writeExcluded(store.path, false)
        // Precondition: without this the assertion below would prove nothing.
        XCTAssertEqual(try readExcluded(store.path), false)

        let prepare: () throws -> URL = subject({ try E2eeStore.prepareStoreDirectory() }, bad: { store })
        let again = try offMain(prepare)
        XCTAssertEqual(again, store)
        XCTAssertEqual(try readExcluded(store.path), true, "the flag must be set on every call, not only at creation")
        #endif
    }

    // MARK: D4 protection class

    func testStoreProtectionAttributes() throws {
        // What is true on the Simulator: every setAttributes(.protectionKey)
        // in prepareStoreDirectory succeeded, or it would have thrown.
        let store = try prepareStore()
        var paths = [store.path, store.appendingPathComponent("attachments").path]
        paths += regularFiles(under: store.path)
        var observed: [String] = []
        for path in paths {
            let attributes = try FileManager.default.attributesOfItem(atPath: path)
            let type = subject(protectionOf(attributes), bad: FileProtectionType.complete)
            let name = path == store.path ? "e2ee" : String(path.dropFirst(store.path.count + 1))
            XCTAssertEqual(protectionProblems(type), [], name)
            observed.append("\(name)=\(type?.rawValue ?? "nil")")
        }
        // The class itself is device leg L-F; this records what the Simulator reports.
        print("T5 observed protection (\(paths.count) entries): \(observed.prefix(6).joined(separator: ", "))")

        // The same call the store makes does not throw here either.
        let temp = try makeTempDir()
        XCTAssertNoThrow(try FileManager.default.setAttributes(
            [.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication],
            ofItemAtPath: temp.path
        ))

        // Negative controls: any reported class other than the store's fails.
        XCTAssertFalse(protectionProblems(.complete).isEmpty)
        XCTAssertFalse(protectionProblems(.completeUnlessOpen).isEmpty)
        XCTAssertFalse(protectionProblems(FileProtectionType.none).isEmpty)
        XCTAssertEqual(protectionProblems(.completeUntilFirstUserAuthentication), [])
    }

    // MARK: D4 WebKit exclusion

    func testExcludeWebKitFromBackupSetsTheFlagOnLibraryWebKit() throws {
        let library = try XCTUnwrap(FileManager.default.urls(for: .libraryDirectory, in: .userDomainMask).first)
        let webKit = library.appendingPathComponent("WebKit", isDirectory: true).path
        // WebKit creates the directory lazily once the host app's webview stores data.
        let present = XCTNSPredicateExpectation(
            predicate: NSPredicate { _, _ in lstatKind(webKit) == S_IFDIR },
            object: nil
        )
        guard XCTWaiter().wait(for: [present], timeout: 10) == .completed else {
            // The set path cannot be pointed at a temp dir (the path is fixed),
            // so only the never-create branch is exercised here.
            E2eeStore.excludeWebKitFromBackup()
            XCTAssertNil(lstatKind(webKit), "excludeWebKitFromBackup must never create Library/WebKit")
            throw XCTSkip("Library/WebKit absent in the host app; only the never-create branch ran")
        }

        #if targetEnvironment(simulator)
        // The app already set the flag at launch, so clear it first, or this
        // test would pass without the call. Restored afterwards.
        let original = try readExcluded(webKit)
        defer { try? writeExcluded(webKit, original ?? true) }
        try writeExcluded(webKit, false)
        XCTAssertEqual(try readExcluded(webKit), false, "precondition: flag cleared")
        #endif

        let exclude: () -> Void = subject(E2eeStore.excludeWebKitFromBackup, bad: {})
        let done = expectation(description: "exclude off main")
        onGlobalQueue {
            exclude()
            done.fulfill()
        }
        wait(for: [done], timeout: 30)
        XCTAssertEqual(try readExcluded(webKit), true)
        XCTAssertEqual(lstatKind(webKit), S_IFDIR)
    }

    // MARK: Support.swift: reject payloads and JSON

    func testRejectJsonMapsEveryErrorKind() {
        let map: (Error) -> String = subject(rejectJson(for:), bad: { String(describing: $0) })
        XCTAssertEqual(rejectMappingProblems(map), [])
        XCTAssertEqual(parseObject(rejectJson(for: T5PlainError()))?["type"] as? String, "crypto_failure")

        // Negative control: forwarding the Swift description is caught.
        XCTAssertFalse(rejectMappingProblems { String(describing: $0) }.isEmpty)
    }

    func testInvalidArgumentEscapesTheFieldIntoValidJson() {
        let naive: (String) -> String = { "{\"type\":\"invalid_argument\",\"field\":\"\($0)\"}" }
        let make: (String) -> String = subject({ E2eeReject.invalidArgument($0).json }, bad: naive)
        XCTAssertEqual(invalidArgumentProblems(make), [])
        // The exact shape the webview's #rethrow parses.
        XCTAssertEqual(E2eeReject.invalidArgument("name").json, "{\"type\":\"invalid_argument\",\"field\":\"name\"}")

        // Negative control: unescaped interpolation is caught.
        XCTAssertFalse(invalidArgumentProblems(naive).isEmpty)
    }

    func testJsonQuoteRoundTripsControlCharactersAndUnicode() {
        let naive: (String) -> String = { "\"" + $0 + "\"" }
        let quote: (String) -> String = subject(jsonQuote, bad: naive)
        XCTAssertEqual(jsonQuoteProblems(quote), [])
        XCTAssertEqual(jsonQuote("a\"b\\c\nd"), "\"a\\\"b\\\\c\\nd\"")
        XCTAssertEqual(jsonQuote(stringFrom([1])), "\"\\u0001\"")
        XCTAssertEqual(jsonQuote(stringFrom([0x1F])), "\"\\u001f\"")
        // Above 0x1F nothing is escaped: a leading U+FEFF passes through as is.
        XCTAssertEqual(scalars(jsonQuote(stringFrom([0xFEFF, 0x62]))), scalars(stringFrom([0x22, 0xFEFF, 0x62, 0x22])))

        // Negative control: quoting without escaping is caught.
        XCTAssertFalse(jsonQuoteProblems(naive).isEmpty)
    }

    func testZeroizeClearsEveryByte() {
        let clear: (inout Data) -> Void = subject(zeroize, bad: { _ in })
        var data = Data(repeating: 0xA5, count: 4096)
        clear(&data)
        XCTAssertEqual(data.count, 4096)
        XCTAssertTrue(data.allSatisfy { $0 == 0 })
        var empty = Data()
        clear(&empty)
        XCTAssertTrue(empty.isEmpty)
    }

    // MARK: Support.swift: engine threads

    /// Submits `count` probe jobs through `submit` and waits for all of them.
    private func runProbeJobs(
        count: Int,
        submit: (@escaping () -> Void) -> Void
    ) -> (samples: [JobSample], maxInFlight: Int) {
        let samples = Locked<[JobSample]>([])
        let flight = Locked(Flight())
        let done = expectation(description: "probe jobs")
        done.expectedFulfillmentCount = count
        for index in 0..<count {
            submit {
                flight.update { state in
                    state.now += 1
                    state.max = Swift.max(state.max, state.now)
                }
                let sample = probeThread(index)
                samples.update { $0.append(sample) }
                flight.update { $0.now -= 1 }
                done.fulfill()
            }
        }
        wait(for: [done], timeout: 30)
        return (samples.snapshot, flight.snapshot.max)
    }

    func testWorkerPoolWithOneThreadRunsJobsFifoOffMainOnAnEightMiBStack() {
        let pool = WorkerPool(name: "T5.pool", threads: 1)
        let submit: (@escaping () -> Void) -> Void = subject({ pool.submit($0) }, bad: { onGlobalQueue($0) })
        let run = runProbeJobs(count: 300, submit: submit)
        XCTAssertEqual(serialRunProblems(run.samples, count: 300, name: "T5.pool", maxInFlight: run.maxInFlight), [])

        // Negative control: a GCD worker (the stack engine calls must not run
        // on) is caught by the stack probe.
        let gcd = runProbeJobs(count: 1) { onGlobalQueue($0) }
        XCTAssertLessThan(gcd.samples.first?.pthreadStack ?? Int.max, eightMiB)
        XCTAssertFalse(serialRunProblems(gcd.samples, count: 1, name: "T5.pool", maxInFlight: gcd.maxInFlight).isEmpty)
    }

    func testRunOnDedicatedThreadRunsOffMainOnItsOwnEightMiBThread() {
        let serial = DispatchQueue(label: "T5.not-dedicated")
        let spawn: (String, @escaping () -> Void) -> Void = subject(
            { runOnDedicatedThread(name: $0, $1) },
            bad: { _, body in onQueue(serial, body) }
        )
        let samples = Locked<[String: JobSample]>([:])
        let overlapped = Locked<Bool?>(nil)
        let partnerRunning = DispatchSemaphore(value: 0)
        let done = expectation(description: "two dedicated threads")
        done.expectedFulfillmentCount = 2
        spawn("T5.dedicated.a") {
            samples.update { $0["a"] = probeThread(0) }
            // B signals only while it runs. If A and B shared one thread or a
            // queue (an open dialog stalling the next command), this times out.
            let met = partnerRunning.wait(timeout: .now() + 10) == .success
            overlapped.update { $0 = met }
            done.fulfill()
        }
        spawn("T5.dedicated.b") {
            samples.update { $0["b"] = probeThread(1) }
            partnerRunning.signal()
            done.fulfill()
        }
        wait(for: [done], timeout: 30)

        let got = samples.snapshot
        XCTAssertEqual(overlapped.snapshot, true, "the two bodies did not run at the same time")
        for (key, name) in [("a", "T5.dedicated.a"), ("b", "T5.dedicated.b")] {
            guard let sample = got[key] else {
                XCTFail("body \(key) never ran")
                continue
            }
            XCTAssertFalse(sample.onMain, key)
            XCTAssertGreaterThanOrEqual(sample.pthreadStack, eightMiB, key)
            XCTAssertGreaterThanOrEqual(sample.threadStack, eightMiB, key)
            XCTAssertEqual(sample.threadName, name, key)
        }
        if let a = got["a"], let b = got["b"] {
            XCTAssertNotEqual(a.thread, b.thread, "both bodies ran on one thread")
        }
    }

    // MARK: Support.swift: the runtime (never its engine: that opens the real store)

    func testRuntimeEngineWorkerIsOneSharedSerialEightMiBThread() {
        let runtime = E2eeRuntime.shared
        XCTAssertTrue(runtime === E2eeRuntime.shared)
        let worker = subject(runtime.engineWorker, bad: WorkerPool(name: "T5.not-the-engine-worker", threads: 1))
        XCTAssertTrue(worker === E2eeRuntime.shared.engineWorker)
        // No-op jobs on the app's real worker; they queue behind any real
        // generic command, which is why the wait allows 30 s.
        let run = runProbeJobs(count: 50) { worker.submit($0) }
        XCTAssertEqual(
            serialRunProblems(run.samples, count: 50, name: "gg.sloga.e2ee.engine", maxInFlight: run.maxInFlight),
            []
        )
    }

    func testRuntimeWithBackgroundTaskRunsTheBodyOnceInlineAndRethrows() throws {
        typealias Wrap = (() throws -> Int) throws -> Int
        let wrap: Wrap = subject({ try E2eeRuntime.shared.withBackgroundTask("T5.bg", $0) }, bad: { _ in 0 })
        let outcome = try offMain { () throws -> (value: Int, runs: Int, inline: Bool, reject: E2eeReject?, core: String?) in
            let caller = ObjectIdentifier(Thread.current)
            var runs = 0
            var inline = false
            let value = try wrap {
                runs += 1
                inline = ObjectIdentifier(Thread.current) == caller
                return 42
            }
            var reject: E2eeReject?
            do {
                _ = try wrap { throw E2eeReject.invalidArgument("T5") }
            } catch {
                reject = error as? E2eeReject
            }
            var core: String?
            do {
                _ = try wrap { throw E2eeError.Failure(message: "{\"type\":\"locked\"}") }
            } catch E2eeError.Failure(let message) {
                core = message
            } catch {
                core = nil
            }
            return (value, runs, inline, reject, core)
        }
        XCTAssertEqual(outcome.value, 42)
        XCTAssertEqual(outcome.runs, 1)
        XCTAssertTrue(outcome.inline, "the body must run on the calling thread")
        XCTAssertEqual(outcome.reject, E2eeReject.invalidArgument("T5"), "the error must come back unchanged")
        XCTAssertEqual(outcome.core, "{\"type\":\"locked\"}")
    }
}
