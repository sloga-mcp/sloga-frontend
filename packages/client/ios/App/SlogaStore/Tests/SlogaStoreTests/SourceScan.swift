// SourceScan.swift: reads the package's own Swift sources for the scan
// tests. The path comes from #filePath, so these tests need the sources on a
// file system the test process can read: the iOS Simulator under xcodebuild
// on the Mac (the gate, contracts §25) qualifies; a physical device does
// not, and there the scan tests FAIL rather than skip (a skipped control
// test would be a silent pass).
import Foundation
import XCTest

enum SourceScan {
    static let packageRoot: URL = URL(fileURLWithPath: #filePath)
        .deletingLastPathComponent() // SlogaStoreTests
        .deletingLastPathComponent() // Tests
        .deletingLastPathComponent() // SlogaStore

    /// The four files the package is known to have; allSourceFiles() fails
    /// the calling test if the enumeration misses one.
    static let knownFiles = [
        "ProtStoreKit.swift", "ProtStorePlugin.swift", "ProtStoreResults.swift", "ProtStoreUpdateGate.swift",
    ]

    /// Every .swift file under Sources/SlogaStore (paths relative to it,
    /// sorted), enumerated so a new source file is always scanned. Fails the
    /// calling test when it finds none or misses a known file.
    static func allSourceFiles() throws -> [String] {
        let sources = packageRoot.appendingPathComponent("Sources/SlogaStore")
        let enumerator = try XCTUnwrap(
            FileManager.default.enumerator(atPath: sources.path),
            "cannot enumerate \(sources.path)"
        )
        let files = enumerator.compactMap { $0 as? String }.filter { $0.hasSuffix(".swift") }.sorted()
        XCTAssertFalse(files.isEmpty, "found no .swift files under \(sources.path)")
        for known in knownFiles {
            XCTAssertTrue(files.contains(known), "the enumeration missed \(known)")
        }
        return files
    }

    /// The file's lines with every `//` comment line removed (a comment that
    /// says "finish" must not count as a call).
    static func code(_ file: String) throws -> [String] {
        let url = packageRoot.appendingPathComponent("Sources/SlogaStore").appendingPathComponent(file)
        let text = try String(contentsOf: url, encoding: .utf8)
        return text.components(separatedBy: "\n").filter {
            !$0.trimmingCharacters(in: .whitespaces).hasPrefix("//")
        }
    }

    /// The code lines from the first line containing `start` up to (not
    /// including) the next line after it that contains `end`.
    static func region(_ file: String, from start: String, to end: String) throws -> String {
        let lines = try code(file)
        guard let first = lines.firstIndex(where: { $0.contains(start) }) else {
            XCTFail("\(file): no line contains \(start)")
            return ""
        }
        let rest = lines[(first + 1)...]
        let stop = rest.firstIndex(where: { $0.contains(end) }) ?? lines.endIndex
        return lines[first..<stop].joined(separator: "\n")
    }
}
