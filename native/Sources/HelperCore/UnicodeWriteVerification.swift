/// Did the typed text actually arrive, or did the target drop the burst?
///
/// `AXWriteVerification` asks this question of the AX tier by reading the caret
/// back. The Unicode tier had no equivalent and, until BUG-1, no answer at all:
/// `CGEvent.post` has no return channel, so "posted" was the strongest thing the
/// tier could say and the ladder reported it as `ok: true`. The contract has
/// admitted since Phase 1 that this `ok` is untrustworthy; on 2026-08-09 that
/// admission cost a user 60.3 s of dictation into `cmux`, behind a green
/// "Inserted" pill and a history row saying `inserted: true`.
///
/// **There is an observable signal, and terminals expose it.** The reason the AX
/// tier declines for a terminal is that `kAXSelectedTextAttribute` is not
/// *settable* — but the same element is still an `AXTextArea` and still
/// *readable*. So: measure the focused element's text length immediately before
/// posting, poll it after posting, and compare. Three outcomes, and the third is
/// the one that keeps this honest:
///
///   - it grew by at least what was typed        → the text landed
///   - it did not change at all                  → nothing landed
///   - anything else, or no readable length      → this target cannot be verified
///
/// **Why `>=` rather than `==`.** The delta belongs to the application, not to
/// us. A terminal at a shell prompt may echo, wrap, redraw a prompt or run a
/// command; an editor may auto-indent or auto-close a bracket. All of those add
/// characters we did not type. Insisting on an exact match would report a
/// perfectly good insertion as unverified in most of the applications this tier
/// exists for.
///
/// **Why a partial delta is `unverifiable` and not a success.** A burst that
/// half-lands is precisely the failure  named ("it can
/// half-succeed silently"), and calling it verified would re-create the bug
/// inside its own fix. It is not `didNotLand` either — some of the text is
/// really there, so telling the user "not inserted" invites a ⌃⌘V that appends
/// the whole thing a second time. Unverified is the truthful state, and the app
/// presents it as "typed, unconfirmed".
///
/// **The expectation is passed in, not derived here.** Unicode injection *types*,
/// so it replaces whatever was selected: N units typed over a selection of L
/// characters grows the field by N − L, and when N == L it grows it by nothing
/// at all. A verifier that assumed L = 0 would call that clean replacement
/// "proven not landed" — a false alarm, which is a worse failure than the one
/// this file fixes, since it fires an error cue over text that is on screen.
/// `UnicodeInserter` reads the selection before typing and subtracts it; a
/// non-positive expectation is unverifiable by construction below.
///
/// **Not measured against cmux.** This is reasoning about how an `AXTextArea`
/// reports its length, plus the one fact the incident establishes (the AX tier
/// reaches a focused element in that application, since it got far enough to
/// read `IsAttributeSettable` and refuse). Whether xterm.js implements
/// `kAXNumberOfCharacters` or `kAXValue` at all is unverified; if it implements
/// neither, this reports "cannot verify" and the app says "typed, unconfirmed"
/// — which is still a strict improvement on a green pill over lost text.
///
/// **The one shape that would make this lie, and the one that has now been
/// observed.** A target whose text length is constant by construction — a
/// terminal that reports a fixed screen grid, or (2026-08-22) an Electron
/// terminal whose AX length is always `0` because xterm.js does not expose the
/// buffer — grows by nothing while taking every character. `0 → 0` is therefore
/// `unverifiable`, not `didNotLand`: that is how cmux looks when the text *did*
/// land, and calling it a failure fires an error overlay over words that are
/// on screen. A non-zero length that did not move is still the BUG-1 case.
/// The escape hatch if a non-zero constant-length target turns up is
/// `GROK_DICTATE_INJECT_VERIFY=0` (and the shipping default is off). It is
/// written down here because a check that can be wrong should say where.

import Foundation

public enum UnicodeWriteVerdict: Sendable, Equatable {
    /// The focused element grew by at least the number of UTF-16 units typed.
    case landed(grewBy: Int)
    /// The length was read before and after and did not move. The BUG-1 case.
    case didNotLand(evidence: String)
    /// A length could not be read, the growth was partial, or the field shrank —
    /// none of which says whether this text is in there.
    case unverifiable(evidence: String)

    /// What was observed, in a sentence a human can read off a log line.
    public var evidence: String {
        switch self {
        case let .landed(growth):
            return "the focused element grew by \(growth) characters"
        case let .didNotLand(evidence), let .unverifiable(evidence):
            return evidence
        }
    }

    /// The events were posted and demonstrably nothing arrived, as opposed to
    /// the check being unable to tell. Only this one may be reported to the app
    /// as `ok: false, verified: false, reason: "verification_failed"`.
    public var provesNothingLanded: Bool {
        if case .didNotLand = self { return true }
        return false
    }
}

public enum UnicodeWriteVerification {
    /// The decision, as a pure function of three numbers.
    ///
    /// `before` and `after` are whatever length the focused element reports —
    /// `kAXNumberOfCharacters` where it exists, otherwise the length of
    /// `kAXValue` — and `nil` when it reported none. The two must come from the
    /// same attribute on the same element; mixing sources would compare a
    /// character count against a UTF-16 count and invent a delta.
    ///
    /// `expectedGrowthUTF16Units` is what was typed minus what it replaced.
    public static func verdict(
        before: Int?,
        after: Int?,
        expectedGrowthUTF16Units expected: Int
    ) -> UnicodeWriteVerdict {
        // Non-positive expectations are real: typing N units over a selection of
        // N characters is a legitimate replacement whose net growth is zero, and
        // it is indistinguishable from nothing having happened. Refusing to
        // judge it is the whole reason the expectation is computed by the caller.
        guard expected > 0 else {
            return .unverifiable(
                evidence:
                    "the text replaced a selection at least as long as itself, so the field was "
                    + "not expected to grow and its length says nothing"
            )
        }
        guard let before else {
            return .unverifiable(
                evidence: "the focused element reported no text length before typing"
            )
        }
        guard let after else {
            return .unverifiable(
                evidence: "the focused element reported no text length after typing"
            )
        }

        let growth = after - before

        if growth >= expected {
            return .landed(grewBy: growth)
        }

        if growth == 0 {
            // `0 → 0` is how a terminal that does not expose its buffer looks
            // (cmux / xterm.js, 2026-08-22): the text landed and AX still
            // reports no characters. An empty field that really dropped the
            // burst looks identical, which is why this refuses to accuse.
            if before == 0 {
                return .unverifiable(
                    evidence:
                        "the focused element reported 0 characters before and after \(expected) "
                        + "UTF-16 units were typed — a terminal that does not expose its buffer "
                        + "looks the same as an empty field that dropped the text, so this proves nothing"
                )
            }
            return .didNotLand(
                evidence:
                    "the focused element still reports \(before) characters after \(expected) "
                    + "UTF-16 units were typed into it — none of the synthetic key events arrived"
            )
        }

        // Partial, or the field got shorter. Both are changes, so neither is the
        // BUG-1 signature; neither is evidence that this text is in there.
        return .unverifiable(
            evidence:
                "the focused element went from \(before) to \(after) characters after \(expected) "
                + "UTF-16 units were typed, which is neither the whole insertion nor no change at "
                + "all"
        )
    }

    /// May the Unicode tier claim `verified: true`?
    ///
    /// Only a landing. The asymmetry that decides everything else in this file:
    /// an under-claim ("typed, unconfirmed") costs the user a quieter HUD state
    /// and a transcript they can still copy; an over-claim costs them the words.
    public static func confirmsInsertion(_ verdict: UnicodeWriteVerdict) -> Bool {
        if case .landed = verdict { return true }
        return false
    }
}
