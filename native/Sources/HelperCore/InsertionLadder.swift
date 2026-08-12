/// The insertion ladder — , contract §3.
///
///   1. **AX** — `AXUIElementSetAttributeValue` on `kAXSelectedTextAttribute`.
///      The only tier that returns an error code, so the only tier whose `ok`
///      is trustworthy.
///   2. **Unicode injection** — `CGEventKeyboardSetUnicodeString`. `ok: true`
///      means the events were posted, not that the characters landed; it can
///      half-succeed silently, which is why the HUD shows the
///      full transcript.
///   3. **Neither** → `tier: "none"`, `ok: false`. **The clipboard is not
///      touched.**
///
/// There is no `import AppKit` in this file and no reference to `NSPasteboard`
/// anywhere beneath it. That is not a coincidence and not a convention: the
/// clipboard is reachable from exactly one file in this package
/// (`Pasteboard.swift`), wired to exactly one command (`copy`), and
/// `ClipboardContainmentTests` asserts both — the source-level check and a spy
/// that counts zero writes across every branch below, including every failure
/// branch.  is a hard product requirement, and
/// IMPLEMENTATION-PLAN.md §5b audits it again in Phase 5.

import Foundation

public struct FrontmostAppInfo: Sendable, Equatable {
    public let bundleId: String?
    public let name: String?
    /// The frontmost application's pid.
    ///
    /// Carried because the AX tier needs it: `AXUIElementCreateApplication(pid)`
    /// is the route that reaches the focused element, and
    /// `AXUIElementCreateSystemWide()` — the obvious one — does not. Measured,
    /// not assumed; see the note in `AXInserter`.
    ///
    /// Not part of the app-facing protocol: `frontmost` frames carry only
    /// `bundleId` and `name` (contract §2), and nothing here is ever sent.
    public let processId: Int32?

    public init(bundleId: String?, name: String?, processId: Int32? = nil) {
        self.bundleId = bundleId
        self.name = name
        self.processId = processId
    }

    public static let unknown = FrontmostAppInfo(bundleId: nil, name: nil)
}

public struct InsertionOutcome: Sendable, Equatable {
    public let tier: InsertTier
    public let ok: Bool
    /// Prose for a human — the real `AXError`, or what the ladder tried.
    public let error: String?
    /// The same failure the app can branch on. `nil` on success. Added in
    /// Phase 5; see `InsertDeclineReason`.
    public let reason: InsertDeclineReason?
    /// The application the ladder actually acted on.
    ///
    /// Added in Phase 5 with the removal of the app-side frontmost check: the
    /// text now goes wherever the user is pointing when the turn ends, so the
    /// app that was frontmost at press time is no longer the app that received
    /// it, and a history row built from the press-time value would name the
    /// wrong one. `nil` when the ladder declined before resolving it.
    public let frontmost: FrontmostAppInfo?

    public init(
        tier: InsertTier,
        ok: Bool,
        error: String?,
        reason: InsertDeclineReason? = nil,
        frontmost: FrontmostAppInfo? = nil
    ) {
        self.tier = tier
        self.ok = ok
        self.error = error
        self.reason = reason
        self.frontmost = frontmost
    }
}

/// Whether the AX tier may trust a `kAXSelectedTextAttribute` write.
///
/// **Measured, and it is the difference between working dictation and text that
/// silently disappears.** Terminal.app and cmux both report
/// `AXUIElementIsAttributeSettable(kAXSelectedTextAttribute) == false` and then
/// return `kAXErrorSuccess` from the write anyway — while inserting nothing. A
/// terminal emulator's AX text area is its *screen buffer*, not the shell's
/// input line, so the write lands nowhere and the ladder stops at a tier the
/// contract calls trustworthy (contract §2: "the only tier whose `ok` is
/// trustworthy").
///
///  anticipated the Unicode tier half-succeeding silently. This
/// is a second silent failure it did not anticipate, in the tier that was
/// supposed to be the reliable one, and it only surfaced because Phase 2's
/// human tests happened to try a terminal after the AX route was fixed.
///
/// Consulting `IsAttributeSettable` first is general: it protects applications
/// nobody has tested, which a hardcoded list of terminal bundle ids would not.
/// The cost of a false skip is ~140 ms of Unicode injection instead of ~20 ms
/// of AX; the cost of a missed one is dictated text vanishing with `ok: true`.
/// That asymmetry decides it.
///
/// This gate only catches the liars that admit it. Arc's web content reports
/// `settable: true`, returns `kAXErrorSuccess` and inserts nothing, and is
/// caught one step later by `AXWriteVerification` instead.
public enum AXSelectedTextGate {
    public static func shouldAttemptWrite(settableCheckSucceeded: Bool, isSettable: Bool) -> Bool {
        // If the check itself failed, we know nothing — attempt the write and
        // let the returned AXError speak. Refusing here would delete the tier
        // for any app whose settable query errors for unrelated reasons.
        guard settableCheckSucceeded else { return true }
        return isSettable
    }
}

public enum TierAttempt: Sendable, Equatable {
    case succeeded
    /// Carries real diagnostic text — for the AX tier, the actual `AXError`,
    /// which is what settles 
    case failed(reason: String)
}

public protocol AccessibilityInserting: AnyObject {
    /// `app` is the frontmost application the ladder already resolved. Passed
    /// in rather than re-queried so the tier acts on exactly the app the
    /// target check approved — two independent queries could disagree if focus
    /// moved between them — and because the AX route needs its pid.
    func insertSelectedText(_ text: String, into app: FrontmostAppInfo) -> TierAttempt
}

public protocol UnicodeInserting: AnyObject {
    func typeText(_ text: String) -> TierAttempt
}

public protocol FrontmostAppProviding: AnyObject {
    var frontmostApp: FrontmostAppInfo { get }
}

/// Kept behind a protocol so the executable can decorate it with "run off the
/// main thread" without the ladder knowing. That decoration is not cosmetic:
/// Unicode injection deliberately paces itself between chunks, and a ladder run
/// on the main run loop would stall the CGEventTap callback long enough for
/// macOS to disable the tap with `kCGEventTapDisabledByTimeout` — the exact
/// silent failure  is about, triggered by our own success path.
public protocol InsertionPerforming: AnyObject {
    func perform(
        text: String,
        targetBundleId: String?,
        completion: @escaping (InsertionOutcome) -> Void
    )
}

public final class InsertionLadder: InsertionPerforming {
    private let accessibility: AccessibilityInserting
    private let unicode: UnicodeInserting
    private let frontmost: FrontmostAppProviding
    private let log: (LogLevel, String) -> Void

    /// Bundle identifiers whose AX tier is skipped outright, straight to
    /// Unicode injection.
    ///
    /// This exists for one specific failure that the ladder cannot otherwise
    /// detect.  expects the AX tier to *fail* in Electron apps
    /// and terminals, and a failure is fine — the ladder falls through. The
    /// dangerous case is an app that returns `kAXErrorSuccess` and then inserts
    /// nothing: the ladder stops at a tier the contract says is trustworthy,
    /// reports `ok: true`, and the text silently never appears. Nothing in the
    /// AX API can distinguish that from a real success.
    ///
    /// Whether any app behaves that way is unmeasured — it is part of what the
    /// Phase 2 insertion matrix finds out. So the escape hatch is a runtime
    /// list (`GROK_DICTATE_AX_SKIP`) rather than a code change: if an app turns
    /// out to lie, it can be excluded during the test session instead of after
    /// a rebuild. Whatever the session finds becomes the documented default.
    private let axSkipBundleIds: Set<String>

    public init(
        accessibility: AccessibilityInserting,
        unicode: UnicodeInserting,
        frontmost: FrontmostAppProviding,
        axSkipBundleIds: Set<String> = [],
        log: @escaping (LogLevel, String) -> Void = { _, _ in }
    ) {
        self.accessibility = accessibility
        self.unicode = unicode
        self.frontmost = frontmost
        self.axSkipBundleIds = axSkipBundleIds
        self.log = log
    }

    public func perform(
        text: String,
        targetBundleId: String?,
        completion: @escaping (InsertionOutcome) -> Void
    ) {
        completion(run(text: text, targetBundleId: targetBundleId))
    }

    public func run(text: String, targetBundleId: String?) -> InsertionOutcome {
        guard !text.isEmpty else {
            return InsertionOutcome(
                tier: .none,
                ok: false,
                error: "there was nothing to insert — the transcript was empty",
                reason: .emptyText
            )
        }

        // Resolved once: the target check and the AX skip list both need it,
        // and two queries could disagree if focus moved between them.
        let current = frontmost.frontmostApp

        // : focus can change during the processing window.
        // Declining is the whole point — typing into whatever happens to be in
        // front now is the failure this check exists to prevent, and
        // Ctrl+Cmd+V is the recovery.
        if let targetBundleId {
            guard current.bundleId == targetBundleId else {
                let now = current.name ?? current.bundleId ?? "an unknown application"
                return InsertionOutcome(
                    tier: .none,
                    ok: false,
                    error:
                        "focus moved to \(now) since you started dictating — "
                        + "nothing was inserted. Point at the right app and press Ctrl+Cmd+V.",
                    reason: .targetChanged,
                    frontmost: current
                )
            }
        }

        var reasons: [String] = []

        if let bundleId = current.bundleId, axSkipBundleIds.contains(bundleId) {
            reasons.append("AX: skipped for \(bundleId) by GROK_DICTATE_AX_SKIP")
            log(.info, "AX tier skipped for \(bundleId) by configuration")
        } else {
            switch accessibility.insertSelectedText(text, into: current) {
            case .succeeded:
                return InsertionOutcome(tier: .ax, ok: true, error: nil, frontmost: current)
            case let .failed(reason):
                reasons.append("AX: \(reason)")
                log(.info, "AX tier declined, falling through to Unicode injection — \(reason)")
            }
        }

        switch unicode.typeText(text) {
        case .succeeded:
            // `ok: true` here means "posted", not "landed" (contract §2). The
            // app shows the full transcript so a partial injection is visible.
            return InsertionOutcome(tier: .unicode, ok: true, error: nil, frontmost: current)
        case let .failed(reason):
            reasons.append("Unicode: \(reason)")
        }

        return InsertionOutcome(
            tier: .none,
            ok: false,
            error:
                "neither insertion method worked, so the text was left alone "
                + "(\(reasons.joined(separator: "; "))). "
                + "It is still in the app — copy it from the pill, or point somewhere else and press Ctrl+Cmd+V.",
            reason: .noTier,
            frontmost: current
        )
    }
}
