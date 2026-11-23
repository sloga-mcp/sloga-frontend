// AppLockPolicy.swift: the app lock's one decision, "does the app lock on
// this return to the foreground", as a pure function (app lock plan 4, 6).
//
// Nothing here reads a clock, the Keychain or UIKit, so the rule can be
// tested on its own. AppLockState feeds it and acts on the answer.
//
// The iPhone rule has no excursion input: pickers and permission alerts do
// not put the app in the background, so there is no trip to exempt.
import Foundation

enum AppLockPolicy {
    /// The timings the settings offer, in seconds: immediately, one minute,
    /// fifteen minutes. Anything else is not a timing.
    static func validTimeout(_ sec: Int) -> Bool {
        sec == 0 || sec == 60 || sec == 900
    }

    /// Whether the app locks now.
    ///
    /// Times are seconds on a clock that keeps counting while the phone sleeps.
    /// leftAt == nil means "never left".
    ///
    /// The rules, in order:
    ///   1. a lock that is off never locks;
    ///   2. a cold start always locks;
    ///   3. an app that never left does not lock;
    ///   4. a clock that went backwards locks;
    ///   5. a timing the settings do not offer locks;
    ///   6. otherwise the app locks once the time away reaches the timing.
    ///
    /// Rules 4 and 6 are written as negations on purpose. For real clock
    /// values they read the same as `now < leftAt` and
    /// `now - leftAt >= timeout`, but a time that is not a number compares
    /// false both ways, and written like this it locks.
    static func shouldLock(
        enabled: Bool, coldStart: Bool, leftAt: TimeInterval?, now: TimeInterval, timeoutSec: Int
    ) -> Bool {
        if !enabled {
            return false
        }
        if coldStart {
            return true
        }
        guard let leftAt = leftAt else {
            return false
        }
        if !(now >= leftAt) {
            return true
        }
        if !validTimeout(timeoutSec) {
            return true
        }
        return !(now - leftAt < Double(timeoutSec))
    }
}
