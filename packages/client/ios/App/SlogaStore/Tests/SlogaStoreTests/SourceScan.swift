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
