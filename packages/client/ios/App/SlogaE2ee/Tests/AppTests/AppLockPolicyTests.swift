// AppLockPolicyTests.swift: the app lock's lock decision (app lock plan 4, 6).
//
// AppLockPolicy is pure, so these tests need no Keychain, no clock and no
// UIKit: they hand the rule its inputs and read the answer.
//
// The rules under test, in the order the type applies them: a lock that is
// off never locks, a cold start always locks, an app that never left does not
// lock, a clock that went backwards locks, a timing the settings do not offer
// locks, and otherwise the app locks once the time away reaches the timing.
//
// The numbers here are written out, not read from the type, so a changed
// constant fails here. Every time used is a whole number of quarter seconds,
// which a Double holds exactly, so the boundary checks are exact.
import Foundation
import XCTest
@testable import SlogaE2ee

/// When the app left, in seconds on the clock that counts through sleep.
private let left: TimeInterval = 5_000

/// The three timings the settings offer, in seconds.
private let timeouts = [0, 60, 900]

/// Timings the settings do not offer.
private let badTimeouts = [
    -1, 1, 30, 59, 61, 300, 899, 901, 3_600, 60_000, 900_000, -60, -900, Int.max, Int.min,
]

/// A warm return with the lock on.
private func warm(_ leftAt: TimeInterval?, _ now: TimeInterval, _ timeoutSec: Int) -> Bool {
    AppLockPolicy.shouldLock(enabled: true, coldStart: false, leftAt: leftAt, now: now, timeoutSec: timeoutSec)
}

final class AppLockPolicyTests: XCTestCase {
    // MARK: validTimeout

    func testValidTimeoutAcceptsOnlyTheThreeOfferedTimings() {
        XCTAssertTrue(AppLockPolicy.validTimeout(0), "[P1a] 0 is refused")
        XCTAssertTrue(AppLockPolicy.validTimeout(60), "[P1b] 60 is refused")
        XCTAssertTrue(AppLockPolicy.validTimeout(900), "[P1c] 900 is refused")
        for bad in badTimeouts {
            XCTAssertFalse(AppLockPolicy.validTimeout(bad), "[P1d] timeout \(bad) is accepted")
        }
    }

    // MARK: 1. The lock is off

    func testALockThatIsOffNeverLocks() {
        func off(_ coldStart: Bool, _ leftAt: TimeInterval?, _ now: TimeInterval, _ timeoutSec: Int) -> Bool {
            AppLockPolicy.shouldLock(
                enabled: false, coldStart: coldStart, leftAt: leftAt, now: now, timeoutSec: timeoutSec)
        }
        // Not on a cold start.
        XCTAssertFalse(off(true, nil, left, 0), "[P2a]")
        XCTAssertFalse(off(true, left, left + 1, 0), "[P2b]")
        // Not after any time away.
        XCTAssertFalse(off(false, left, left, 0), "[P2c]")
        XCTAssertFalse(off(false, left, left + 86_400, 60), "[P2d]")
        XCTAssertFalse(off(false, left, .greatestFiniteMagnitude, 900), "[P2e]")
        // Not on inputs that lock when it is on.
        XCTAssertFalse(off(false, left, left - 1, 0), "[P2f] a clock that went backwards")
        XCTAssertFalse(off(false, left, left + 1, 30), "[P2g] an unknown timing")
        XCTAssertFalse(off(true, left, left - 1, -1), "[P2h] everything at once")
        XCTAssertFalse(off(false, left, .nan, 0), "[P2i] a time that is not a number")
    }

    // MARK: 2. A cold start

    func testAColdStartAlwaysLocks() {
        func cold(_ leftAt: TimeInterval?, _ now: TimeInterval, _ timeoutSec: Int) -> Bool {
            AppLockPolicy.shouldLock(
                enabled: true, coldStart: true, leftAt: leftAt, now: now, timeoutSec: timeoutSec)
        }
        for timeout in timeouts {
            // A new process has no leaving time.
            XCTAssertTrue(cold(nil, left, timeout), "[P3a] timeout \(timeout)")
            XCTAssertTrue(cold(nil, 0, timeout), "[P3b] timeout \(timeout)")
            // A leaving time inside the timing does not help.
            XCTAssertTrue(cold(left, left + 1, timeout), "[P3c] timeout \(timeout)")
            XCTAssertTrue(cold(left, left, timeout), "[P3d] timeout \(timeout)")
        }
        // Not with an unknown timing either.
        XCTAssertTrue(cold(nil, left, 30), "[P3e]")
    }

    // MARK: 3. The app never left

    func testAnAppThatNeverLeftDoesNotLock() {
        for timeout in timeouts {
            XCTAssertFalse(warm(nil, left, timeout), "[P4a] timeout \(timeout)")
            XCTAssertFalse(warm(nil, 0, timeout), "[P4b] timeout \(timeout)")
            XCTAssertFalse(warm(nil, .greatestFiniteMagnitude, timeout), "[P4c] timeout \(timeout)")
        }
    }

    func testNeverLeftIsDecidedBeforeTheClockAndTheTimingAreRead() {
        // Clocks that would lock had the app left.
        XCTAssertFalse(warm(nil, -1, 0), "[P5a]")
        XCTAssertFalse(warm(nil, -.greatestFiniteMagnitude, 0), "[P5b]")
        XCTAssertFalse(warm(nil, .nan, 0), "[P5c]")
        // Timings the settings do not offer, which would lock had the app left.
        XCTAssertFalse(warm(nil, left, 30), "[P5d]")
        XCTAssertFalse(warm(nil, left, -1), "[P5e]")
    }

    /// Only nil means "never left". Zero and times below zero are leaving
    /// times like any other (unlike Android, where 0 stands for "never").
    func testOnlyNilMeansNeverLeft() {
        XCTAssertTrue(warm(0, 0, 0), "[P6a] a leaving time of 0 was read as never left")
        XCTAssertTrue(warm(0, 60, 60), "[P6b]")
        XCTAssertFalse(warm(0, 59, 60), "[P6c]")
        XCTAssertTrue(warm(-10, -10, 0), "[P6d] a leaving time below 0 was read as never left")
        XCTAssertTrue(warm(-10, 50, 60), "[P6e]")
        XCTAssertFalse(warm(-10, 49, 60), "[P6f]")
    }

    // MARK: 4. The clock went backwards

    func testAClockThatWentBackwardsLocks() {
        for timeout in timeouts {
            XCTAssertTrue(warm(left, left - 0.25, timeout), "[P7a] timeout \(timeout)")
            XCTAssertTrue(warm(left, left - 1, timeout), "[P7b] timeout \(timeout)")
            XCTAssertTrue(warm(left, left - 3_600, timeout), "[P7c] timeout \(timeout)")
            XCTAssertTrue(warm(left, 0, timeout), "[P7d] timeout \(timeout)")
            XCTAssertTrue(warm(left, -1, timeout), "[P7e] timeout \(timeout)")
            // Clocks no phone has.
            XCTAssertTrue(warm(left, -.greatestFiniteMagnitude, timeout), "[P7f] timeout \(timeout)")
            XCTAssertTrue(
                warm(.greatestFiniteMagnitude, -.greatestFiniteMagnitude, timeout), "[P7g] timeout \(timeout)")
            XCTAssertTrue(warm(.infinity, left, timeout), "[P7h] timeout \(timeout)")
            XCTAssertTrue(warm(left, -.infinity, timeout), "[P7i] timeout \(timeout)")
        }
    }

    /// The backwards check comes before the timing: with fifteen minutes set,
    /// a return one second "before" leaving still locks.
    func testAClockThatWentBackwardsLocksWhateverTheTiming() {
        XCTAssertFalse(warm(left, left + 1, 900), "[P8a] the control return locked")
        XCTAssertTrue(warm(left, left - 1, 900), "[P8b]")
    }

    // MARK: 5. A timing the settings do not offer

    func testAnUnknownTimingLocks() {
        for bad in badTimeouts {
            // Back at once, which every offered timing but 0 would let through.
            XCTAssertTrue(warm(left, left, bad), "[P9a] timeout \(bad)")
            XCTAssertTrue(warm(left, left + 1, bad), "[P9b] timeout \(bad)")
            XCTAssertTrue(warm(left, left + 86_400, bad), "[P9c] timeout \(bad)")
        }
    }

    // MARK: 6. The time away against the timing

    func testImmediatelyLocksOnEveryReturn() {
        XCTAssertTrue(warm(left, left, 0), "[P10a]")
        XCTAssertTrue(warm(left, left + 0.25, 0), "[P10b]")
        XCTAssertTrue(warm(left, left + 1, 0), "[P10c]")
        XCTAssertTrue(warm(left, left + 86_400, 0), "[P10d]")
        XCTAssertTrue(warm(left, .greatestFiniteMagnitude, 0), "[P10e]")
    }

    func testOneMinuteLocksOnceAMinuteHasGoneBy() {
        XCTAssertFalse(warm(left, left, 60), "[P11a]")
        XCTAssertFalse(warm(left, left + 1, 60), "[P11b]")
        XCTAssertFalse(warm(left, left + 30, 60), "[P11c]")
        XCTAssertFalse(warm(left, left + 59.75, 60), "[P11d]")
        // Exactly at the timing locks.
        XCTAssertTrue(warm(left, left + 60, 60), "[P11e]")
        XCTAssertTrue(warm(left, left + 60.25, 60), "[P11f]")
        XCTAssertTrue(warm(left, left + 900, 60), "[P11g]")
    }

    func testFifteenMinutesLocksOnceFifteenMinutesHaveGoneBy() {
        XCTAssertFalse(warm(left, left, 900), "[P12a]")
        XCTAssertFalse(warm(left, left + 60, 900), "[P12b]")
        XCTAssertFalse(warm(left, left + 899.75, 900), "[P12c]")
        // Exactly at the timing locks.
        XCTAssertTrue(warm(left, left + 900, 900), "[P12d]")
        XCTAssertTrue(warm(left, left + 900.25, 900), "[P12e]")
    }

    /// The clock keeps counting through sleep, so eight hours asleep is eight
    /// hours away, whatever the timing.
    func testAPhoneThatSleptPastTheTimingLocks() {
        let eightHours: TimeInterval = 8 * 3_600
        for timeout in timeouts {
            XCTAssertTrue(warm(left, left + eightHours, timeout), "[P13a] timeout \(timeout)")
        }
        // Clocks no phone has: the subtraction overflows to infinity and
        // still locks.
        XCTAssertTrue(warm(1, .greatestFiniteMagnitude, 900), "[P13b]")
        XCTAssertTrue(warm(-.greatestFiniteMagnitude, .greatestFiniteMagnitude, 900), "[P13c]")
        XCTAssertTrue(warm(left, .infinity, 60), "[P13d]")
    }

    func testTheTimingHoldsAcrossTheWholeFirstHalfHour() {
        var checked = 0
        for timeout in timeouts {
            let limit = Double(timeout)
            // Quarter-second steps, counted in whole numbers so no error builds up.
            for step in 0...7_200 {
                let away = Double(step) * 0.25
                XCTAssertEqual(
                    warm(left, left + away, timeout), away >= limit, "[P14a] timeout \(timeout) away \(away)")
                checked += 1
            }
        }
        XCTAssertGreaterThan(checked, 20_000, "[P14b] the walk covered too few returns")
    }

    // MARK: Times that are not numbers

    /// The real clock never gives these. If one ever turned up the app locks:
    /// a time the rule cannot compare is not a reason to stay open.
    func testATimeThatIsNotANumberLocks() {
        for timeout in timeouts {
            XCTAssertTrue(warm(left, .nan, timeout), "[P15a] timeout \(timeout)")
            XCTAssertTrue(warm(.nan, left, timeout), "[P15b] timeout \(timeout)")
            XCTAssertTrue(warm(.nan, .nan, timeout), "[P15c] timeout \(timeout)")
            // Infinity minus infinity is not a number.
            XCTAssertTrue(warm(.infinity, .infinity, timeout), "[P15d] timeout \(timeout)")
        }
    }

    // MARK: The rule fed the way AppLockState feeds it

    func testLeaveAndReturnInSequence() {
        // First launch with the lock on.
        XCTAssertTrue(
            AppLockPolicy.shouldLock(enabled: true, coldStart: true, leftAt: nil, now: 100, timeoutSec: 60),
            "[P16a] the cold start did not lock")
        // Unlocked, away twenty seconds, back.
        XCTAssertFalse(warm(200, 220, 60), "[P16b] a short trip locked")
        // The leaving time is cleared on every return, so a foreground with
        // no background before it has none.
        XCTAssertFalse(warm(nil, 221, 60), "[P16c] a return with no leaving time locked")
        // Away two minutes.
        XCTAssertTrue(warm(300, 420, 60), "[P16d] two minutes away did not lock")
    }
}
