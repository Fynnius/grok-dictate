/// The Unicode tier reports success only when the target's text says so.
///
/// Everything reachable without a real application on a real screen is here. What
/// is *not* coverable headlessly, and has to be run by a human against a
/// terminal, is the input to these functions: whether a given application
/// exposes `kAXNumberOfCharacters` or a readable `kAXValue` at all, and what it
/// does to them while synthetic key events arrive. `--probe-insert` prints the
/// resulting verdict for any app you point it at.
///
/// The bias under every case below is one-directional and deliberate: an
/// under-claim ("typed, unconfirmed") costs a quieter HUD state; an over-claim
/// costs the user their words, which is BUG-1. A *false* `didNotLand` costs
/// something new — an error cue over text that is on screen — so it is the one
/// verdict that has to be squeezed hardest.

import Testing

@testable import HelperCore

@Suite("Unicode write verification")
struct UnicodeWriteVerificationTests {
    /// The incident's transcript: 60.3 s of dictation, 760 UTF-16 units.
    private let n = 760

    private func isUnverifiable(_ verdict: UnicodeWriteVerdict) -> Bool {
        if case .unverifiable = verdict { return true }
        return false
    }

    // MARK: - Landed

    @Test("a field that grew by exactly what was typed took it")
    func exactGrowth() {
        let verdict = UnicodeWriteVerification.verdict(
            before: 1_200,
            after: 1_960,
            expectedGrowthUTF16Units: n
        )
        #expect(verdict == .landed(grewBy: 760))
        #expect(UnicodeWriteVerification.confirmsInsertion(verdict))
    }

    @Test("growing by more than was typed still counts as landed")
    func extraGrowth() {
        // The delta belongs to the application. A terminal echoes, wraps, redraws
        // a prompt and may run what was typed; an editor auto-indents and closes
        // brackets. Insisting on an exact match would report a good injection as
        // unverified in most of the applications this tier exists for.
        for extra in [1, 12, 4_000] {
            let verdict = UnicodeWriteVerification.verdict(
                before: 100,
                after: 100 + n + extra,
                expectedGrowthUTF16Units: n
            )
            #expect(UnicodeWriteVerification.confirmsInsertion(verdict))
        }
    }

    @Test("an insert into an empty field is confirmed from zero")
    func fromEmpty() {
        let verdict = UnicodeWriteVerification.verdict(
            before: 0,
            after: 11,
            expectedGrowthUTF16Units: 11
        )
        #expect(verdict == .landed(grewBy: 11))
    }

    // MARK: - Did not land — the BUG-1 case

    @Test("a field that did not change at all took none of it")
    func unchangedLength() {
        // 2026-08-09: 760 UTF-16 units posted as 38 events in ~245 ms, dropped
        // in full by cmux, reported as `ok: true` with a green "Inserted" pill
        // and `inserted: true` in history. This is the only verdict allowed to
        // contradict that, and it is the only one the app shows as a failure.
        let verdict = UnicodeWriteVerification.verdict(
            before: 4_096,
            after: 4_096,
            expectedGrowthUTF16Units: n
        )
        #expect(verdict.provesNothingLanded)
        #expect(UnicodeWriteVerification.confirmsInsertion(verdict) == false)
        #expect(verdict.evidence.contains("4096"))
        #expect(verdict.evidence.contains("760"))
    }

    @Test("zero-to-zero length is unverifiable, not a failure (cmux, 2026-08-22)")
    func stillEmptyIsUnverifiable() {
        // cmux / xterm.js reports AX length 0 whether or not the buffer took
        // the keystrokes. Accusing that of dropping the text is the false
        // fail that put "Not inserted" over words that were on screen.
        let verdict = UnicodeWriteVerification.verdict(
            before: 0,
            after: 0,
            expectedGrowthUTF16Units: 11
        )
        #expect(isUnverifiable(verdict))
        #expect(verdict.provesNothingLanded == false)
        #expect(UnicodeWriteVerification.confirmsInsertion(verdict) == false)
    }

    // MARK: - Cannot tell

    @Test("a partial delta is unverified, not a success and not a failure")
    func partialGrowth() {
        // The half-succeeded injection  warned about. Calling it
        // verified would rebuild BUG-1 inside its own fix; calling it "did not
        // land" would invite a ⌃⌘V that appends the whole transcript a second
        // time on top of the part that is already there.
        let verdict = UnicodeWriteVerification.verdict(
            before: 1_200,
            after: 1_500,
            expectedGrowthUTF16Units: n
        )
        #expect(isUnverifiable(verdict))
        #expect(verdict.provesNothingLanded == false)
        #expect(UnicodeWriteVerification.confirmsInsertion(verdict) == false)
    }

    @Test("one character short of the whole insertion is still not a success")
    func almostAllOfIt() {
        let verdict = UnicodeWriteVerification.verdict(
            before: 0,
            after: n - 1,
            expectedGrowthUTF16Units: n
        )
        #expect(isUnverifiable(verdict))
    }

    @Test("a field that got shorter proves nothing")
    func shrank() {
        // A terminal that scrolled, a field that was cleared, an editor that
        // reformatted. All real, none of them evidence about this text.
        let verdict = UnicodeWriteVerification.verdict(
            before: 4_096,
            after: 2_048,
            expectedGrowthUTF16Units: n
        )
        #expect(isUnverifiable(verdict))
        #expect(verdict.provesNothingLanded == false)
    }

    @Test("an unreadable length before typing cannot be verified")
    func unreadableBefore() {
        let verdict = UnicodeWriteVerification.verdict(
            before: nil,
            after: 900,
            expectedGrowthUTF16Units: n
        )
        #expect(isUnverifiable(verdict))
        #expect(verdict.evidence.contains("before"))
    }

    @Test("an unreadable length after typing cannot be verified")
    func unreadableAfter() {
        // Not a failure: the events were posted, and an element that stopped
        // answering says nothing about whether they arrived.
        let verdict = UnicodeWriteVerification.verdict(
            before: 100,
            after: nil,
            expectedGrowthUTF16Units: n
        )
        #expect(isUnverifiable(verdict))
        #expect(verdict.evidence.contains("after"))
        #expect(verdict.provesNothingLanded == false)
    }

    // MARK: - Replacing a selection

    @Test("typing over a selection of the same length is unverifiable, not a failure")
    func replacementOfEqualLength() {
        // The false-alarm case that decides where the expectation is computed.
        // Unicode injection *types*, so it replaces the selection: 12 units over
        // 12 selected characters is a clean replacement whose net growth is
        // zero. A verifier that assumed nothing was selected would call that
        // "proven not landed" and fire an error cue over text the user can see.
        let verdict = UnicodeWriteVerification.verdict(
            before: 500,
            after: 500,
            expectedGrowthUTF16Units: 0
        )
        #expect(isUnverifiable(verdict))
        #expect(verdict.provesNothingLanded == false)
    }

    @Test("typing over a longer selection shrinks the field and is unverifiable")
    func replacementOfLongerSelection() {
        let verdict = UnicodeWriteVerification.verdict(
            before: 500,
            after: 460,
            expectedGrowthUTF16Units: -40
        )
        #expect(isUnverifiable(verdict))
    }

    @Test("a partly-consumed selection still confirms when the net growth arrives")
    func replacementOfShorterSelection() {
        // 760 typed over 60 selected: the field should end up 700 longer.
        let verdict = UnicodeWriteVerification.verdict(
            before: 1_000,
            after: 1_700,
            expectedGrowthUTF16Units: n - 60
        )
        #expect(UnicodeWriteVerification.confirmsInsertion(verdict))
    }

    // MARK: - The policy itself

    @Test("only a confirmed landing is trusted")
    func policy() {
        #expect(UnicodeWriteVerification.confirmsInsertion(.landed(grewBy: 1)))
        #expect(UnicodeWriteVerification.confirmsInsertion(.didNotLand(evidence: "…")) == false)
        #expect(UnicodeWriteVerification.confirmsInsertion(.unverifiable(evidence: "…")) == false)
    }

    @Test("only didNotLand may be reported to the user as a failure")
    func onlyOneVerdictAccuses() {
        #expect(UnicodeWriteVerdict.didNotLand(evidence: "…").provesNothingLanded)
        #expect(UnicodeWriteVerdict.unverifiable(evidence: "…").provesNothingLanded == false)
        #expect(UnicodeWriteVerdict.landed(grewBy: 3).provesNothingLanded == false)
    }

    @Test("every verdict carries evidence a human can read")
    func evidenceIsAlwaysPresent() {
        // These strings reach the user: the `didNotLand` one becomes the `error`
        // on an `insert_result` the HUD shows (IMPLEMENTATION-PLAN.md §4: "STT
        // failed" is a defect).
        let verdicts: [UnicodeWriteVerdict] = [
            .landed(grewBy: 760),
            .didNotLand(evidence: "the focused element still reports 4096 characters"),
            .unverifiable(evidence: "the focused element reported no text length"),
        ]
        for verdict in verdicts {
            #expect(verdict.evidence.isEmpty == false)
        }
    }

    @Test("nothing typed is unverifiable rather than landed")
    func nothingTyped() {
        // Unreachable through the ladder, which refuses empty text before any
        // tier runs. Asserted so a verifier that quietly passes a degenerate
        // input fails here rather than in the field.
        #expect(
            isUnverifiable(
                UnicodeWriteVerification.verdict(
                    before: 10,
                    after: 10,
                    expectedGrowthUTF16Units: 0
                )
            )
        )
    }
}
