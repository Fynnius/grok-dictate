/// Keeps the event tap alive.
///
/// **Non-negotiable** — IMPLEMENTATION-PLAN.md §3.2 and  If a
/// tap callback runs long, macOS silently disables the tap and delivers
/// `kCGEventTapDisabledByTimeout`; the tap must be re-armed with
/// `CGEventTapEnable`. This is *the* canonical bug in every macOS hotkey
/// utility: it works fine, then stops after hours of uptime, with no error, no
/// log and no crash. It will not show up in an afternoon of testing.
///
/// Two independent recoveries, because one of them can be missed:
///
///   1. **Reactive** — the callback receives `.tapDisabledByTimeout` or
///      `.tapDisabledByUserInput` and re-arms immediately.
///   2. **Watchdog** — a timer polls `CGEvent.tapIsEnabled` and re-arms
///      anything that is off. This catches a disable that arrives while the
///      process is wedged, or any disable delivered by a route the callback
///      never sees. Cheap: one Mach-port query per tick.
///
/// The CoreGraphics types are behind `EventTapHandle` so both paths are unit-
/// testable with no windowserver and no Accessibility grant — the plan asks for
/// "a test that forces the disable and asserts recovery", and a fake handle is
/// the only way to force it deterministically.

import Foundation

public protocol EventTapHandle: AnyObject {
    var isEnabled: Bool { get }
    func setEnabled(_ enabled: Bool)
}

public enum TapDisableCause: String, Sendable, Equatable {
    case timeout = "kCGEventTapDisabledByTimeout"
    case userInput = "kCGEventTapDisabledByUserInput"
}

public final class TapHealthMonitor {
    private let handle: EventTapHandle
    private let log: (LogLevel, String) -> Void
    private let onRearmed: () -> Void

    public private(set) var reactiveRearmCount = 0
    public private(set) var watchdogRearmCount = 0

    public init(
        handle: EventTapHandle,
        log: @escaping (LogLevel, String) -> Void,
        onRearmed: @escaping () -> Void = {}
    ) {
        self.handle = handle
        self.log = log
        self.onRearmed = onRearmed
    }

    /// Called from the tap callback when macOS reports the tap disabled.
    public func handleDisabled(cause: TapDisableCause) {
        reactiveRearmCount += 1
        handle.setEnabled(true)
        // Warn, not info: this is the failure that makes a working app look
        // broken, and it should be visible in the app's log when it happens.
        log(
            .warn,
            "event tap re-armed after \(cause.rawValue) (\(reactiveRearmCount) so far this run)"
        )
        onRearmed()
    }

    /// Called from the watchdog timer.
    public func checkAndRearmIfNeeded() {
        guard !handle.isEnabled else { return }
        watchdogRearmCount += 1
        handle.setEnabled(true)
        log(
            .warn,
            "event tap was found disabled by the watchdog and re-armed "
                + "(\(watchdogRearmCount) so far this run) — the hotkey would have been dead"
        )
        onRearmed()
    }
}

/// Emit-on-change, with the first observation always counting as a change.
///
/// Used for both `secure_input` and the unsolicited `frontmost` push, which the
/// contract specifies as "emitted **on change only**, plus once shortly after
/// `ready` to establish the initial value" — starting from `nil` is what makes
/// those one rule instead of two.
public final class ChangeTracker<Value: Equatable> {
    private var last: Value?

    public init() {}

    public var current: Value? { last }

    /// Returns the value when it differs from the previous observation (or is
    /// the first), `nil` when there is nothing to report.
    public func observe(_ value: Value) -> Value? {
        guard last != value else { return nil }
        last = value
        return value
    }

    public func reset() {
        last = nil
    }
}
