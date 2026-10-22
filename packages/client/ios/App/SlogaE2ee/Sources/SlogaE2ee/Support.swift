// Support.swift: the small pieces every SlogaE2ee file shares (IE plan D1,
// D5): the reject payload, the worker threads engine calls run on, and the
// process's one engine.
//
// Rules this file exists to make easy to follow (gate G7 scans for them):
//   - no engine call ever runs on the main thread: every function that calls
//     a method of an `E2eeEngine` starts with
//     `dispatchPrecondition(condition: .notOnQueue(.main))`;
//   - nothing in this module ever waits synchronously on the main queue
//     (a blocked engine thread waiting on main while main waits on the
//     engine is the deadlock D1 warns about); to hand work to main, post it
//     with `async` and, if the caller must wait, wait on a semaphore off
//     main;
//   - engine calls run on threads with an 8 MiB stack (Rust's own default for
//     spawned threads is 2 MiB; a GCD worker has 512 KiB, which deep serde or
//     OpenMLS recursion could overflow, and the release build aborts on a
//     stack overflow).
import AcutestE2eeBindings
import Foundation
import UIKit

/// A plugin rejection. `json` is exactly the string the webview's
/// `CapacitorTransport.#rethrow` parses back into the desktop-identical typed
/// error object (`{"type": ...}`).
struct E2eeReject: Error, Equatable {
    let json: String

    /// `{"type":"invalid_argument","field":"<field>"}`
    static func invalidArgument(_ field: String) -> E2eeReject {
        E2eeReject(json: "{\"type\":\"invalid_argument\",\"field\":\(jsonQuote(field))}")
    }

    /// The least-informative variant: anything that is not a typed core error.
    static let cryptoFailure = E2eeReject(json: "{\"type\":\"crypto_failure\"}")

    /// The user cancelled a native dialog or sheet.
    static let declined = E2eeReject(json: "{\"type\":\"declined\"}")
}

/// The reject payload for any error thrown on a plugin path: a typed core
/// error (`E2eeError.Failure`, whose message IS the core's scrubbed JSON) is
/// forwarded verbatim, an `E2eeReject` as its own JSON, and anything else
/// degrades to `crypto_failure` (never a raw Swift error description).
func rejectJson(for error: Error) -> String {
    if let reject = error as? E2eeReject {
        return reject.json
    }
    if let failure = error as? E2eeError, case .Failure(let message) = failure, message.hasPrefix("{") {
        return message
    }
    return E2eeReject.cryptoFailure.json
}

/// `s` as a JSON string literal (quotes included). Deterministic, no
/// Foundation round trip: escapes `"`, `\` and every control character.
func jsonQuote(_ s: String) -> String {
    var out = "\""
    out.reserveCapacity(s.utf8.count + 2)
    for scalar in s.unicodeScalars {
        switch scalar {
        case "\"": out += "\\\""
        case "\\": out += "\\\\"
        case "\n": out += "\\n"
        case "\r": out += "\\r"
        case "\t": out += "\\t"
        default:
            if scalar.value < 0x20 {
                out += String(format: "\\u%04x", scalar.value)
            } else {
                out.unicodeScalars.append(scalar)
            }
        }
    }
    out += "\""
    return out
}

/// Best-effort zeroing of a plaintext buffer we own (a copy handed to WebKit
/// or UIKit is theirs).
func zeroize(_ data: inout Data) {
    if !data.isEmpty {
        data.resetBytes(in: 0..<data.count)
    }
}

/// Stack size of every thread that calls into the Rust core.
let engineThreadStackSize = 8 << 20

/// A fixed set of long-lived threads draining one FIFO job queue. With
/// `threads: 1` it is a serial executor (the engine worker). Jobs never run
/// on the main thread.
final class WorkerPool: @unchecked Sendable {
    private let condition = NSCondition()
    private var jobs: [() -> Void] = []

    init(name: String, threads: Int) {
        precondition(threads >= 1)
        for index in 0..<threads {
            let thread = Thread { [self] in
                self.drain()
            }
            thread.name = threads == 1 ? name : "\(name).\(index)"
            thread.stackSize = engineThreadStackSize
            thread.qualityOfService = .userInitiated
            thread.start()
        }
    }

    func submit(_ job: @escaping () -> Void) {
        condition.lock()
        jobs.append(job)
        condition.signal()
        condition.unlock()
    }

    private func drain() {
        while true {
            condition.lock()
            while jobs.isEmpty {
                condition.wait()
            }
            let job = jobs.removeFirst()
            condition.unlock()
            autoreleasepool {
                job()
            }
        }
    }
}

/// Run `body` on a NEW thread of its own (8 MiB stack). Used for every
/// confirm-gated command (D1 rule (a): an open dialog must not stall the
/// engine worker), the recovery sheet, attachment transfer and save.
func runOnDedicatedThread(name: String, _ body: @escaping () -> Void) {
    let thread = Thread {
        autoreleasepool {
            body()
        }
    }
    thread.name = name
    thread.stackSize = engineThreadStackSize
    thread.qualityOfService = .userInitiated
    thread.start()
}

/// The process's one engine (D5 "Engine lifecycle") and the worker generic
/// commands run on.
final class E2eeRuntime: @unchecked Sendable {
    static let shared = E2eeRuntime()

    /// The serial worker for the generic `call` route. Decrypt order is
    /// already serialized by the webview's `#decryptQueue`; the core's mutex
    /// serializes engine access anyway.
    let engineWorker = WorkerPool(name: "gg.sloga.e2ee.engine", threads: 1)

    private let lock = NSLock()
    private var cached: E2eeEngine?

    private init() {}

    /// The engine, built on first use. Construction opens nothing (the store
    /// opens lazily inside ShellEngine on the first command that needs it),
    /// so this never provisions. The store directory is created and its
    /// protection class and backup exclusion asserted BEFORE the path reaches
    /// Rust. A live engine is never replaced (the native one-engine-per-dir
    /// registry would refuse a second one while the first is alive); a failed
    /// construction leaves nothing cached, and the next call tries again.
    func engine() throws -> E2eeEngine {
        dispatchPrecondition(condition: .notOnQueue(.main))
        lock.lock()
        defer { lock.unlock() }
        if let engine = cached {
            return engine
        }
        let directory = try E2eeStore.prepareStoreDirectory()
        let engine = try E2eeEngine(storeDir: directory.path, confirm: NativeConfirmPresenter.shared)
        cached = engine
        return engine
    }

    /// Run `body` inside a UIKit background task, so an engine call that has
    /// started is not frozen half-way when the app is backgrounded (D5
    /// "Background"). `beginBackgroundTask` is documented as safe to call off
    /// the main thread.
    func withBackgroundTask<T>(_ name: String, _ body: () throws -> T) rethrows -> T {
        let task = BackgroundTask(name: name)
        defer { task.end() }
        return try body()
    }
}

/// One UIKit background task; ends exactly once (here or in the expiration
/// handler, whichever comes first).
private final class BackgroundTask: @unchecked Sendable {
    private let lock = NSLock()
    private var identifier: UIBackgroundTaskIdentifier = .invalid

    init(name: String) {
        let id = UIApplication.shared.beginBackgroundTask(withName: name) { [weak self] in
            self?.end()
        }
        lock.lock()
        identifier = id
        lock.unlock()
    }

    func end() {
        lock.lock()
        let id = identifier
        identifier = .invalid
        lock.unlock()
        if id != .invalid {
            UIApplication.shared.endBackgroundTask(id)
        }
    }
}
