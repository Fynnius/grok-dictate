/// Did the AX write actually land, or did the application take it and throw it
/// away?
///
/// `AXSelectedTextGate` (see `InsertionLadder.swift`) catches the liars that
/// *admit* it — a terminal reports `kAXSelectedTextAttribute` as not settable
/// and then returns `kAXErrorSuccess` from the write anyway. `phase-2-report.md`
/// §6.4 recorded what that gate cannot catch and left it open:
///
/// > An app that reports `settable: true` and still discards the write would be
/// > undetectable. A read-back-after-write check was considered and rejected for
/// > v1 as fragile and slow; Phase 5 may revisit.
///
/// **That app exists.** A 13.8 s dictation aimed at a text field on a web page
/// in Arc (`company.thebrowser.Browser`, Chromium) produced, from the user's
/// log on 2026-08-09:
///
/// ```
/// 10:17:37.649Z INFO  app.stt:     turn complete {"durationSec":13.8,"finals":2,…}
/// 10:17:37.660Z DEBUG app.session: state {"from":"inserting","to":"idle","event":"INSERT_RESULT"}
/// ```
///
/// 11 ms from dispatch to result, and **no** `AX tier declined, falling through
/// to Unicode injection` line — `InsertionLadder.run` emits that on every
/// decline, so its absence means the AX tier returned `.succeeded`. Phase 2
/// measured the AX tier at 32–50 ms and Unicode injection at 156–166 ms
/// (phase-2-report.md §4, HT-3), so 11 ms is AX and nothing else. Nothing
/// appeared on screen, the HUD showed a green "Inserted" pill, and the words
/// were recoverable only from history.
///
/// So the return code is not evidence. Something observable has to be, and the
/// cheapest observable thing is the caret: **an insertion of N UTF-16 units at
/// the caret moves the caret forward and collapses any selection.** Two small
/// reads of `kAXSelectedTextRange` around the write, one `AXValue` each, say
/// whether that happened. Deliberately *not* `kAXValue`: that copies the entire
/// document across the process boundary on every insertion, which is slow in a
/// large field and pulls another application's text — possibly someone else's
/// private data,  — into this process for no reason. Deliberately
/// not `kAXNumberOfCharacters` either: it is an optional attribute that many
/// fields do not implement, and computing its expected delta needs the selection
/// length anyway, so it would be a *third* read rather than a cheaper first one.
/// `--probe-ax` reports both of those, because a probe a human runs by hand can
/// afford what the insertion path cannot.
///
/// **Not measured against Arc.** The mechanism below is reasoning about how AX
/// text ranges behave plus the two facts Phase 2 did measure; nobody has yet run
/// it against the application that provoked it. `--probe-ax` prints every input
/// to the decision so that run answers the question in one command.
public struct AXSelectedRange: Sendable, Equatable, CustomStringConvertible {
    public let location: Int
    public let length: Int

    public init(location: Int, length: Int) {
        self.location = location
        self.length = length
    }

    public var description: String { "{\(location), \(length)}" }
}

public enum AXWriteVerdict: Sendable, Equatable {
    /// The caret moved forward, so text went in.
    ///
    /// `caretAdvancedBy` is not required to equal the number of UTF-16 units
    /// written, and the difference is not treated as a failure. AppKit reports
    /// these ranges as `NSRange`s over UTF-16, but other accessibility
    /// implementations count differently — WebKit in particular works in
    /// character positions, so an emoji written as a surrogate pair may advance
    /// the caret by one — and a target with text substitution enabled can change
    /// the length of what it stored. Any forward movement is proof that a write
    /// happened; only an *unchanged* range is proof that none did.
    case landed(caretAdvancedBy: Int)
    /// The range is exactly what it was before the write. This is the Arc case.
    case didNotLand(evidence: String)
    /// One of the reads failed, or the range moved in a way that says nothing
    /// about whether the text landed.
    case unverifiable(evidence: String)

    /// What was observed, in a sentence a human can read back off a log line.
    public var evidence: String {
        switch self {
        case let .landed(advance):
            return "the caret advanced by \(advance)"
        case let .didNotLand(evidence), let .unverifiable(evidence):
            return evidence
        }
    }

    /// The application demonstrably took the write and threw it away, as
    /// opposed to the check being unable to tell. Both decline; they are logged
    /// differently because one is a fact about the target application and the
    /// other is a fact about our own confidence.
    public var isDiscardedWrite: Bool {
        if case .didNotLand = self { return true }
        return false
    }
}

public enum AXWriteVerification {
    public static func verdict(
        before: AXSelectedRange?,
        after: AXSelectedRange?,
        insertedUTF16Count: Int
    ) -> AXWriteVerdict {
        // Unreachable through the ladder, which refuses empty text before any
        // tier runs. Kept because a verifier that quietly passes a degenerate
        // input is how a check stops being a check.
        guard insertedUTF16Count > 0 else {
            return .unverifiable(
                evidence: "nothing was written, so there is no caret movement to look for"
            )
        }
        guard let before else {
            return .unverifiable(
                evidence: "the selected range could not be read before the write"
            )
        }
        guard let after else {
            return .unverifiable(
                evidence: "the selected range could not be read after the write"
            )
        }

        if after == before {
            return .didNotLand(
                evidence:
                    "the selected range is still \(before) after writing \(insertedUTF16Count) "
                    + "UTF-16 units — the caret did not move, so the application accepted the "
                    + "write and discarded it"
            )
        }

        let advance = after.location - before.location
        if after.length == 0, advance > 0 {
            return .landed(caretAdvancedBy: advance)
        }

        // Everything else: the caret went backwards, stayed put while the
        // selection changed, or a selection survived the write. Each is a real
        // change, so it is not the Arc failure — but none of them is evidence
        // that this text went in, which is what the tier is about to claim.
        return .unverifiable(
            evidence:
                "the selected range went from \(before) to \(after) after writing "
                + "\(insertedUTF16Count) UTF-16 units, which is neither an unchanged range nor a "
                + "caret that moved forward"
        )
    }

    /// May the AX tier report `.succeeded`?
    ///
    /// **Only a verified landing.** `phase-2-report.md` §3.2 argued the other
    /// way for the *settable* check — "unknown is not no", so a failed settable
    /// query still attempts the write — and that is still right there, because
    /// the fallback from an unknown settable query is to try and then read a
    /// real `AXError`. Here there is no further evidence to fall back on: the
    /// `AXError` has already been read, it said success, and success is exactly
    /// what a discarded write also says.
    ///
    /// The asymmetry runs the other way too. A false decline costs one Unicode
    /// injection — 156–166 ms measured in phase-2-report.md §4 instead of
    /// 32–50 ms, in a tier that landed 300 characters byte-identically in six
    /// applications — and the user sees their text. A missed lie costs the user
    /// their words behind a green "Inserted" pill. ~140 ms against a silent
    /// data loss is not a close call.
    ///
    /// The cost is bounded by where it is spent, and that is the part that keeps
    /// this from quietly deleting the AX tier for Notes, TextEdit and Safari
    /// (32/41/50 ms, all `ax`, HT-3): `AXInserter` reads the range **before**
    /// writing, so an application that does not expose `kAXSelectedTextRange`
    /// declines without a write having happened, and one that does exposes it
    /// after the write as well. The only case that both writes and cannot verify
    /// is an element that stops answering between the two reads. Declining there
    /// can duplicate text — the write may have landed and Unicode will type it
    /// again — which is unpleasant and visible, and  already puts
    /// visible-and-recoverable above silent: ⌃⌘V appends rather than replaces,
    /// and "recovery is select-and-redo".
    public static func trustsWrite(_ verdict: AXWriteVerdict) -> Bool {
        if case .landed = verdict { return true }
        return false
    }
}
