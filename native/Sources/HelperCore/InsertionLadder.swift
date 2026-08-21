/// The insertion ladder — , contract §3.
///
///   1. **AX** — `AXUIElementSetAttributeValue` on `kAXSelectedTextAttribute`,
///      confirmed by reading the caret back (`AXWriteVerification`).
///   2. **Unicode injection** — `CGEventKeyboardSetUnicodeString`. The events
///      carry no return channel, so posting them proves nothing; since BUG-1 the
///      tier measures the target's text length around the injection instead and
///      says which of "landed", "did not land" and "cannot tell" it observed.
///   3. **Neither** → `tier: "none"`, `ok: false`. **The clipboard is not
///      touched.**
///
/// Every rung reports a `verification` alongside `ok`, and the two are not the
/// same claim: `ok: true` with `verification == .notPossible` means "typed,
/// unconfirmed". That distinction is the whole of BUG-1 — a 60.3 s dictation
/// into `cmux` was posted as 38 events in 245 ms, dropped in full, and reported
/// as plain success because the ladder had no way to say anything weaker.
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
    /// Whether anything outside the tier's own API confirmed the text is in the
    /// target. Sent as `verified` (contract §2); see `InsertionVerification`.
    ///
    /// Defaulted to `.notPossible` in the initialiser rather than left required:
    /// the declines below — empty text, a moved target — never got as far as a
    /// tier, and "not possible" is the honest thing to say about a verification
    /// that never ran.
    public let verification: InsertionVerification
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
        verification: InsertionVerification = .notPossible,
        error: String?,
        reason: InsertDeclineReason? = nil,
        frontmost: FrontmostAppInfo? = nil
    ) {
        self.tier = tier
        self.ok = ok
        self.verification = verification
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

/// What one rung of the ladder has to say for itself.
///
/// Four cases rather than two, and the distinction between the first two is the
/// point: **`.succeeded` means "I did my work", `.confirmed` means "and I have
/// evidence it arrived".** Before BUG-1 there was only `.succeeded`, and the
/// Unicode tier returned it unconditionally the moment `CGEvent.post` had been
/// called — which is a statement about this process, not about the target.
public enum TierAttempt: Sendable, Equatable {
    /// The tier did its work; nothing here can tell whether the text landed.
    /// Reported to the app as `ok: true, verified: null` — "typed, unconfirmed".
    case succeeded
    /// The tier did its work and verified the result against the target: the
    /// caret moved (AX), or the focused element's text grew (Unicode).
    case confirmed
    /// The tier did its work, verification ran, and it proved the text is not
    /// there. Only the Unicode tier can produce this — the AX tier reads back
    /// *before* the fall-through, so its "did not land" is a `.failed` that the
    /// ladder answers by trying the next rung, and it stays that way.
    case notLanded(reason: String)
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
    /// `app` is the frontmost application the ladder already resolved, passed in
    /// for the same reasons the AX tier gets it — the tier acts on exactly the
    /// app the target check approved, and verification needs the pid to reach
    /// the focused element (`AXUIElementCreateApplication(pid)`, the route
    /// Phase 2 measured as the only one that works on macOS 26).
    ///
    /// The parameter arrived with BUG-1. Injection itself does not need it and
    /// still does not use it: synthetic key events go wherever focus is, which
    /// is why this tier works in applications the AX tier cannot reach at all.
    func typeText(_ text: String, into app: FrontmostAppInfo) -> TierAttempt
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
            case .confirmed:
                return InsertionOutcome(
                    tier: .ax,
                    ok: true,
                    verification: .confirmed,
                    error: nil,
                    frontmost: current
                )
            case .succeeded:
                // Reachable only with `GROK_DICTATE_AX_VERIFY=0`, which trusts
                // the return code the way the tier did before Phase 5. The
                // outcome is still `ok: true` — that is what the flag is for —
                // but it must not claim `verified`, or switching verification
                // off would quietly restore the Arc bug *and* the green pill.
                return InsertionOutcome(tier: .ax, ok: true, error: nil, frontmost: current)
            case let .notLanded(reason), let .failed(reason):
                // The AX tier's own "did not land" is a decline: it read the
                // caret back *before* anything else ran, so falling through to
                // Unicode is safe and is what recovers the text. Folded in here
                // rather than given a branch of its own, because treating it as
                // terminal would delete the recovery path the Arc fix relies on.
                reasons.append("AX: \(reason)")
                log(.info, "AX tier declined, falling through to Unicode injection — \(reason)")
            }
        }

        switch unicode.typeText(text, into: current) {
        case .confirmed:
            return InsertionOutcome(
                tier: .unicode,
                ok: true,
                verification: .confirmed,
                error: nil,
                frontmost: current
            )
        case .succeeded:
            // `ok: true` here means "posted", not "landed" (contract §2): this
            // target exposes no readable text length, or focus could not be
            // resolved. The app presents it as "typed, unconfirmed" and shows
            // the full transcript, so a partial injection stays recoverable.
            return InsertionOutcome(tier: .unicode, ok: true, error: nil, frontmost: current)
        case let .notLanded(reason):
            // BUG-1, reported honestly. `tier: .unicode` rather than `.none`
            // because the events really were posted — something may be on
            // screen, so this is not the "nothing was attempted" case — and
            // `ok: false` because the one thing we know is that the text is not
            // where the user wanted it. That pair is what fires the app's
            // existing not-inserted HUD, its error cue and its re-insert path.
            let target = current.name ?? current.bundleId ?? "the frontmost application"
            // At `info`, and paired with the tier's own `warn` — the same split
            // the AX tier already uses. The diagnosis of the other application
            // belongs to whoever measured it; this line only records what the
            // ladder decided to do about it.
            log(
                .info,
                "Unicode injection did not land in \(target) — \(reason). Reporting it as not "
                    + "inserted; the transcript is still in the app"
            )
            return InsertionOutcome(
                tier: .unicode,
                ok: false,
                verification: .provenNotLanded,
                error:
                    "the text was typed into \(target) but did not arrive — \(reason). "
                    + "It is still in the app — copy it from the pill, or point somewhere else and "
                    + "press Ctrl+Cmd+V.",
                reason: .verificationFailed,
                frontmost: current
            )
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
