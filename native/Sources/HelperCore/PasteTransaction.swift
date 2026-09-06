/// One clipboard paste, as a decision rather than a side effect.
///
/// The paste tier publishes a *promise* on the pasteboard and posts ⌘V. macOS
/// then calls back when a consumer asks for the data, and that callback is the
/// only native "the target took our text" signal on this platform. This type
/// owns everything that has to be decided about those callbacks; the syscalls
/// that produce them are in `grok-dictate-helper/PasteInserter.swift`.
///
/// It is here, pure and value-typed, because the decisions are the part that is
/// easy to get wrong and impossible to test with a windowserver in the way.
/// `swift test` runs this headless, with no TCC grant and no pasteboard.
///
/// ## The two rules that make a receipt trustworthy
///
/// 1. **Only receipts observed after the chord was posted count.** An earlier
///    read is a clipboard manager or an antivirus reacting to the pasteboard
///    *change*, not the paste target reacting to ⌘V. Counting one of those as a
///    landing would report success for text nobody pasted.
/// 2. **Only take the pasteboard back while we still own it.** If the user
///    copied something in the meantime, their action wins and we touch nothing.
///    Ownership is `changeCount` plus `pasteboardChangedOwner:`, both answers
///    from the OS rather than inferences of ours.
///
/// ## Two questions, not one
///
/// `outcome(now:)` asks *has the insertion resolved* — is there something to
/// tell the user? `mayRelease(now:)` asks *is the pasteboard safe to take back*.
/// They are deliberately separate and they resolve at different times.
///
/// The insertion resolves on the **first** receipt after the chord: that is the
/// moment the target has the text, and making the user wait past it would put
/// the quiet period below into the number that this whole change exists to
/// reduce. Releasing waits for the **last** receipt plus a quiet period,
/// because Chromium probes the pasteboard and then reads it — several receipts
/// arrive per paste, and clearing after the first would hand the real read an
/// empty pasteboard.
///
/// ## The hazard this exists to prevent
///
/// Falling through to Unicode injection after a paste that *did* land types the
/// transcript twice. The receipt is what makes the fall-through safe and it is
/// exactly why a fixed delay would not be: the ⌘V keystroke is only *enqueued*,
/// and the target reads whenever its event loop gets to it. Both VoiceInk and
/// Wispr Flow document users getting their old clipboard pasted instead of the
/// transcript, and both ship an "increase the restore delay" workaround for a
/// race they lose often enough to have written it down.
///
/// Mechanism from Handy (`src-tauri/src/paste_tx/`, MIT) — read, understood, and
/// reimplemented here. No source copied; the split between this decision and a
/// thin syscall binding is ours.

import Foundation

public struct PasteTransaction: Equatable {
    /// How a paste ended. Only `.landed` means the text is in the target;
    /// everything else falls through to the injection tier.
    public enum Settlement: Equatable, Sendable {
        /// A consumer read the transcript after our chord.
        case landed
        /// Somebody else took the pasteboard before anyone read ours. Their
        /// copy wins; we clear nothing and the ladder falls through.
        case ownershipLost
        /// The chord could not be constructed or posted at all.
        case chordFailed
        /// Nobody ever read it. The commonest real cause is an application that
        /// does not paste with ⌘V.
        case timedOut
    }

    // MARK: - Constants

    /// How long the receipts must be quiet before the pasteboard is taken back.
    ///
    /// **Chosen, not measured**, and copied from Handy, who chose it for the
    /// same reason: Chromium asks for the pasteboard more than once per paste —
    /// a probe, then the read — so clearing after the first receipt would give
    /// the real read an empty pasteboard and the user an empty paste.
    ///
    /// Too short: an empty paste in a Chromium target. Too long: the transcript
    /// sits on the clipboard a moment longer than it needs to, which is the
    /// failure mode this design is willing to have.
    public static let receiptQuietPeriod: TimeInterval = 0.2

    /// How long the promise stays up after a chord that could not be posted.
    ///
    /// **Chosen, not measured.** Not zero, because the failure is "we could not
    /// construct or post the events" and something else on the machine — a
    /// clipboard manager, the user pressing ⌘V themselves — may still read it.
    /// Short, because there is nothing to wait for and the ladder has an
    /// injection tier standing by.
    public static let chordFailureGrace: TimeInterval = 0.5

    /// The hard ceiling, after which the paste is given up on regardless.
    ///
    /// **Chosen, not measured**, and Handy's number. It is long because the
    /// cost of overrunning is bounded and small: the fall-through clears the
    /// pasteboard *before* it injects, so a target that reads late reads
    /// nothing and the user gets their text once. The cost of cutting it too
    /// short is the same, so there is no strong pull in either direction and no
    /// reason to differ from the one implementation that has field data.
    public static let timeout: TimeInterval = 8.0

    // MARK: - State

    /// All times are on a **monotonic** clock (`ProcessInfo.systemUptime`), not
    /// wall time: a transaction is at most 8 seconds long and an NTP step
    /// during one must not be able to settle or extend it.
    public let publishedAt: TimeInterval
    public private(set) var chordAt: TimeInterval?
    public private(set) var chordFailedAt: TimeInterval?
    public private(set) var lastReceiptAt: TimeInterval?
    /// Receipts for the *text* type observed after the chord. The only ones
    /// that mean anything (rule 1).
    public private(set) var receiptsAfterChord = 0
    /// Receipts observed before the chord, or with no chord posted at all.
    /// Never a landing; kept because "a clipboard manager read us first" is the
    /// diagnosis somebody will want and it is otherwise invisible.
    public private(set) var receiptsBeforeChord = 0
    public private(set) var ownershipLost = false
    /// Set when the pasteboard has been taken back. Everything after is a
    /// no-op.
    ///
    /// **Not bookkeeping — load-bearing.** `NSPasteboard.clearContents()` fires
    /// `pasteboardChangedOwner:` on the process that called it, so our own
    /// settle looks exactly like the user copying something else. Without this
    /// flag the settle path runs a second time on every successful paste.
    /// (Measured 2026-09-06; report §9.5.)
    public private(set) var settled = false

    public init(publishedAt: TimeInterval) {
        self.publishedAt = publishedAt
    }

    // MARK: - Recording what happened

    public mutating func recordChord(at now: TimeInterval) {
        guard !settled else { return }
        chordAt = now
    }

    public mutating func recordChordFailure(at now: TimeInterval) {
        guard !settled else { return }
        chordFailedAt = now
    }

    /// A consumer asked for the transcript.
    ///
    /// Marker-type requests are **not** passed here: a clipboard manager
    /// inspecting `org.nspasteboard.TransientType` to decide whether to record
    /// the entry is not a paste target, and `PromisedPasteboardOwner` keeps the
    /// two apart so this type never has to know a pasteboard type at all.
    public mutating func recordTextReceipt(at now: TimeInterval) {
        guard !settled else { return }
        if let chordAt, now >= chordAt {
            receiptsAfterChord += 1
            lastReceiptAt = now
        } else {
            receiptsBeforeChord += 1
        }
    }

    public mutating func recordOwnershipLost() {
        guard !settled else { return }
        ownershipLost = true
    }

    public mutating func markSettled() {
        settled = true
    }

    // MARK: - Deciding

    /// Has the insertion resolved? `nil` means keep waiting.
    ///
    /// A receipt outranks a lost ownership deliberately: if the target read our
    /// text and *then* the user copied something, the paste landed. Reporting
    /// `ownershipLost` there would fall through to injection and type the
    /// transcript a second time, which is the one outcome this whole design is
    /// built to avoid.
    public func outcome(now: TimeInterval) -> Settlement? {
        if settled { return nil }
        if receiptsAfterChord > 0 { return .landed }
        if ownershipLost { return .ownershipLost }
        if let chordFailedAt, now - chordFailedAt >= Self.chordFailureGrace { return .chordFailed }
        if now - publishedAt >= Self.timeout { return .timedOut }
        return nil
    }

    /// May the pasteboard be taken back yet?
    ///
    /// True once the receipts have been quiet, or once there is nothing left to
    /// wait for. The ceiling is unconditional so that a pathological stream of
    /// receipts cannot hold the transcript on the clipboard forever.
    public func mayRelease(now: TimeInterval) -> Bool {
        if settled { return false }
        if now - publishedAt >= Self.timeout { return true }
        if let lastReceiptAt { return now - lastReceiptAt >= Self.receiptQuietPeriod }
        // No receipt has arrived. Nothing is going to make waiting safer, so
        // release as soon as the insertion itself has resolved — and on the
        // fall-through paths that is what makes injecting safe, because the
        // pasteboard is emptied before a single key is posted.
        return outcome(now: now) != nil
    }

    /// The settlement to report, re-read **after** the pasteboard has been
    /// taken back.
    ///
    /// Callbacks arrive on the same thread that performs the release, so once
    /// `clearContents()` has returned no receipt can still be in flight. A
    /// receipt that arrived in the window between deciding to give up and
    /// actually clearing turns a fall-through into a landing — which is the
    /// difference between the user getting their text once and getting it
    /// twice. Cheap, and it closes the only race left in the design.
    public func verdict(after decision: Settlement) -> Settlement {
        receiptsAfterChord > 0 ? .landed : decision
    }
}
