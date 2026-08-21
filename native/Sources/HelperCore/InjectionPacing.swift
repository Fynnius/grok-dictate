/// How fast the Unicode tier is allowed to type.
///
/// **BUG-1, from the incident report of 2026-08-09, and it is pure data loss
/// behind a green pill.** A 60.3 s hands-free dictation into `cmux` (Electron +
/// xterm.js) produced 760 UTF-16 units. The ladder correctly refused the AX tier
/// — a terminal reports `kAXSelectedTextAttribute` as not settable — and the
/// Unicode tier posted the text as **38 synthetic keystroke events inside
/// ~245 ms**, the flat 5 ms spacing this file now replaces. cmux dropped the
/// burst. Nothing in the process could see that: `CGEvent.post` returns nothing,
/// so the tier reported "posted", the ladder mapped that to `ok: true`, the HUD
/// showed "Inserted", history recorded `inserted: true`, and a minute of
/// dictation existed only in the transcript the user had to copy out by hand.
///
/// The same application had taken three insertions the same day — 42, 49 and 79
/// UTF-16 units, 3–4 chunks each — and landed all of them. The variable is not
/// the application and not the characters; it is **how many events arrive back
/// to back**, and a flat delay cannot tell four events from thirty-eight.
///
/// Two things this deliberately does not do.
///
///  - **It does not shrink the chunk.** 20 UTF-16 units per event is the ceiling
///    `TextChunker` cites, and Phase 2 measured 317 units landing byte-identical
///    in six applications at that size. Halving the chunk would double the event
///    count and make the burst *longer*, which is the opposite of the fix; the
///    number of events is the thing under suspicion.
///  - **It does not adapt to the target.** A per-bundle-id table would be a list
///    of the applications somebody happened to test. Length is a property of the
///    dictation, is known before a single event is posted, and is the one
///    variable the incident actually isolates.
///
/// `GROK_DICTATE_INJECT_DELAY_MS` still wins wherever it is set, and that is the
/// point of it: it is the debugging escape hatch that lets the person at the
/// keyboard sweep the value in one sitting rather than one rebuild per attempt
/// (see the header of `Settings.swift`). An unparseable or out-of-range value is
/// *not* an override — it falls back to the default and the rule below applies,
/// because a typo in an environment variable must not silently restore the
/// behaviour that lost the dictation.

import Foundation

/// The two numbers the injection loop runs on, plus whether the long-text rule
/// produced them — which is only ever used to say so in a log line, because the
/// one thing worse than a slow insert is a slow insert nobody can explain.
public struct InjectionPacing: Sendable, Equatable {
    public let chunkUnits: Int
    public let interChunkDelay: TimeInterval
    public let isPacedForLength: Bool

    public init(chunkUnits: Int, interChunkDelay: TimeInterval, isPacedForLength: Bool) {
        self.chunkUnits = chunkUnits
        self.interChunkDelay = interChunkDelay
        self.isPacedForLength = isPacedForLength
    }

    /// For a `log` frame and for `--probe-insert`'s header.
    public var summary: String {
        "\(chunkUnits) UTF-16 units per event, \(Int(interChunkDelay * 1000)) ms between events"
    }
}

public enum InjectionPacer {
    /// The baseline the environment resolved to, before length is considered.
    public struct Baseline: Sendable, Equatable {
        public let chunkUnits: Int
        public let interChunkDelay: TimeInterval
        /// `GROK_DICTATE_INJECT_DELAY_MS` was set *and* parsed. Only then is the
        /// delay authoritative; see this file's header.
        public let delayIsExplicit: Bool

        public init(chunkUnits: Int, interChunkDelay: TimeInterval, delayIsExplicit: Bool) {
            self.chunkUnits = chunkUnits
            self.interChunkDelay = interChunkDelay
            self.delayIsExplicit = delayIsExplicit
        }
    }

    /// Above this many UTF-16 units, slow down.
    ///
    /// **Chosen, not measured**, and the evidence brackets it loosely on both
    /// sides: 79 units landed in cmux, 760 did not, and Phase 2's 317-unit
    /// fixture landed byte-identically in six other applications at 5 ms
    /// (`native/probe-out/*.log`). Anywhere in 80–759 would be defensible; the
    /// incident report proposed ~200 and nothing measured contradicts it.
    ///
    /// The threshold is deliberately below the largest burst known to work. What
    /// that costs is arithmetic, not risk: a 317-unit insert that would have been
    /// fine now takes ~170 ms longer. What the other choice costs is another
    /// minute of dictation.
    public static let longTextThresholdUTF16Units = 200

    /// The spacing used above the threshold.
    ///
    /// The bottom of the 15–20 ms band the incident report proposes — the
    /// cheapest value in the recommended range, since nothing distinguishes them.
    /// Also chosen, not measured: nobody has yet reproduced the cmux drop at a
    /// known spacing, which would need a rebuild-free sweep of
    /// `GROK_DICTATE_INJECT_DELAY_MS` against that application.
    ///
    /// Cost, in full: the 760-unit insertion that failed becomes 38 events over
    /// ~570 ms of pacing instead of ~190 ms. That is 26× inside the app's 15 s
    /// `INSERT_TIMEOUT_MS`, and stays inside it up to roughly 19,000 UTF-16
    /// units — about 25 minutes of uninterrupted speech in a single turn, which
    /// is beyond anything this product has produced (60 s of dictation was 760
    /// units). Above that the insert would time out app-side; it is a known,
    /// unhandled limit rather than an overlooked one.
    public static let longTextInterChunkDelay: TimeInterval = 0.015

    /// The whole pacing decision, as a function of length alone.
    ///
    /// Kept pure and out of `UnicodeInserter` so it can be tested without a
    /// windowserver: what a 760-unit insert does is a question `swift test` can
    /// answer, and it is the question the incident turned on.
    public static func pacing(forUTF16Count count: Int, baseline: Baseline) -> InjectionPacing {
        // The escape hatch is authoritative — including when it asks for
        // something slower than the rule below would.
        if baseline.delayIsExplicit {
            return InjectionPacing(
                chunkUnits: baseline.chunkUnits,
                interChunkDelay: baseline.interChunkDelay,
                isPacedForLength: false
            )
        }

        guard count > longTextThresholdUTF16Units else {
            // Short insertions keep exactly today's timing. The 11-unit reply
            // that lands instantly must go on landing instantly: making every
            // insert slower to fix the long ones would trade a rare data loss
            // for a permanent regression in the common case.
            return InjectionPacing(
                chunkUnits: baseline.chunkUnits,
                interChunkDelay: baseline.interChunkDelay,
                isPacedForLength: false
            )
        }

        // `max`, never a plain assignment: a baseline that is already slower
        // than the long-text delay is somebody's deliberate default, and
        // speeding it up here would be this file causing the bug it exists to
        // prevent.
        let delay = max(baseline.interChunkDelay, longTextInterChunkDelay)
        return InjectionPacing(
            chunkUnits: baseline.chunkUnits,
            interChunkDelay: delay,
            isPacedForLength: delay > baseline.interChunkDelay
        )
    }
}
