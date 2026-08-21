import Testing

@testable import HelperCore

@Suite("AX settable gate")
struct AXSelectedTextGateTests {
    @Test("a settable attribute is written")
    func settableIsWritten() {
        #expect(AXSelectedTextGate.shouldAttemptWrite(settableCheckSucceeded: true, isSettable: true))
    }

    @Test("a non-settable attribute is refused, however the write would answer")
    func notSettableIsRefused() {
        // Terminal.app and cmux, measured: settable=false, and the write then
        // returns kAXErrorSuccess while inserting nothing. Trusting the write's
        // return value is what makes dictated text vanish with ok:true.
        #expect(
            AXSelectedTextGate.shouldAttemptWrite(settableCheckSucceeded: true, isSettable: false)
                == false
        )
    }

    @Test("a failed settable check falls back to attempting the write")
    func unknownIsPermissive() {
        // Knowing nothing is not the same as knowing no. Refusing here would
        // delete the AX tier for any app whose settable query errors for an
        // unrelated reason.
        #expect(
            AXSelectedTextGate.shouldAttemptWrite(settableCheckSucceeded: false, isSettable: false)
        )
        #expect(
            AXSelectedTextGate.shouldAttemptWrite(settableCheckSucceeded: false, isSettable: true)
        )
    }
}

@Suite("Insertion ladder")
struct InsertionLadderTests {
    private func ladder(
        ax: TierAttempt,
        unicode: TierAttempt,
        frontmost bundleId: String? = "com.apple.Notes"
    ) -> (InsertionLadder, StubAccessibilityInserter, StubUnicodeInserter) {
        let axStub = StubAccessibilityInserter(result: ax)
        let unicodeStub = StubUnicodeInserter(result: unicode)
        let ladder = InsertionLadder(
            accessibility: axStub,
            unicode: unicodeStub,
            frontmost: StubFrontmost(bundleId: bundleId, name: "Notes")
        )
        return (ladder, axStub, unicodeStub)
    }

    @Test("AX first: a successful AX write reports tier ax and never reaches Unicode")
    func axWins() {
        let (ladder, ax, unicode) = self.ladder(ax: .confirmed, unicode: .succeeded)
        let outcome = ladder.run(text: "hallo", targetBundleId: nil)
        #expect(outcome.tier == .ax)
        #expect(outcome.ok)
        // The AX tier verifies by reading the caret back, so it says so on the
        // wire. `ok: true` alone is what BUG-1 could not distinguish from a
        // burst that vanished.
        #expect(outcome.verification == .confirmed)
        #expect(outcome.error == nil)
        // Reported so the app can name the application in history: the app-side
        // frontmost check was removed in Phase 5, so it no longer knows.
        #expect(outcome.frontmost?.bundleId == "com.apple.Notes")
        #expect(ax.calls == ["hallo"])
        #expect(unicode.calls.isEmpty)
    }

    @Test("a failed AX write falls through to Unicode")
    func fallsThroughToUnicode() {
        // The expected path in every Electron app and terminal.
        let (ladder, ax, unicode) = self.ladder(
            ax: .failed(reason: "kAXErrorAttributeUnsupported (-25205)"),
            unicode: .succeeded
        )
        let outcome = ladder.run(text: "hallo", targetBundleId: nil)
        #expect(outcome.tier == .unicode)
        #expect(outcome.ok)
        // "Typed, unconfirmed": the events went out and this target exposes no
        // readable text length. `ok: true` with `verified: null` is the honest
        // shape of that, and the app stops presenting it as plain success.
        #expect(outcome.verification == .notPossible)
        #expect(outcome.error == nil)
        #expect(ax.calls == ["hallo"])
        #expect(unicode.calls == ["hallo"])
        // The tier is handed the app the target check approved — it needs the
        // pid to read the focused element back.
        #expect(unicode.targets.count == 1)
        #expect(unicode.targets[0].bundleId == "com.apple.Notes")
    }

    @Test("a Unicode injection that was measured landing reports verified")
    func unicodeConfirmed() {
        let (ladder, _, _) = self.ladder(
            ax: .failed(reason: "kAXSelectedTextAttribute is not settable"),
            unicode: .confirmed
        )
        let outcome = ladder.run(text: "hallo", targetBundleId: nil)
        #expect(outcome.tier == .unicode)
        #expect(outcome.ok)
        #expect(outcome.verification == .confirmed)
        #expect(outcome.reason == nil)
    }

    @Test("a Unicode injection proven not to have landed is reported as a failure")
    func unicodeProvenNotLanded() {
        // BUG-1, end to end through the ladder. On 2026-08-09 this exact path —
        // a terminal refusing the AX tier, 760 UTF-16 units posted as 38 events
        // in 245 ms and dropped in full — produced `ok: true` and a green
        // "Inserted" pill over a minute of lost dictation.
        let (ladder, _, _) = self.ladder(
            ax: .failed(reason: "kAXSelectedTextAttribute is not settable"),
            unicode: .notLanded(reason: "the focused element still reports 4096 characters")
        )
        let outcome = ladder.run(text: "hallo", targetBundleId: nil)
        // `unicode`, not `none`: the events really were posted, so this is not
        // the "nothing was attempted" case, and the user may be looking at part
        // of the text.
        #expect(outcome.tier == .unicode)
        #expect(outcome.ok == false)
        #expect(outcome.verification == .provenNotLanded)
        // What the app branches on to show the not-inserted HUD, play the error
        // cue and offer the re-insert.
        #expect(outcome.reason == .verificationFailed)
        #expect(outcome.error?.contains("4096") == true)
        // IMPLEMENTATION-PLAN.md §4: errors carry actionable text.
        #expect(outcome.error?.contains("Ctrl+Cmd+V") == true)
        #expect(outcome.frontmost?.bundleId == "com.apple.Notes")
    }

    @Test("a dropped injection is logged, naming the app and the evidence")
    func notLandedIsLogged() {
        // The incident left *no* trace anywhere: the log recorded a successful
        // insert. This line is the one somebody will look for when they ask why
        // the pill went red, so it is asserted rather than assumed. At `info`,
        // paired with the `warn` the tier itself emits — the same split the AX
        // tier already uses, where the diagnosis of the other application
        // belongs to whoever measured it.
        var logged: [(LogLevel, String)] = []
        let ladder = InsertionLadder(
            accessibility: StubAccessibilityInserter(result: .failed(reason: "not settable")),
            unicode: StubUnicodeInserter(
                result: .notLanded(reason: "the focused element still reports 4096 characters")
            ),
            frontmost: StubFrontmost(bundleId: "dev.cmux.app", name: "cmux"),
            log: { level, message in logged.append((level, message)) }
        )
        _ = ladder.run(text: "hallo", targetBundleId: nil)

        let lines = logged.filter { $0.1.contains("did not land") }
        #expect(lines.count == 1)
        #expect(lines.first?.0 == .info)
        #expect(lines.first?.1.contains("cmux") == true)
        #expect(lines.first?.1.contains("4096") == true)
        #expect(lines.first?.1.contains("not inserted") == true)
    }

    @Test("an AX tier that could not verify itself reports ok without claiming verified")
    func axUnverifiedIsNotVerified() {
        // Reachable only with GROK_DICTATE_AX_VERIFY=0, which trusts the return
        // code the way the tier did before Phase 5. It stays `ok: true` — that
        // is what the flag is for — but claiming `verified` would mean switching
        // verification off silently upgraded the report it produces.
        let (ladder, _, unicode) = self.ladder(ax: .succeeded, unicode: .confirmed)
        let outcome = ladder.run(text: "hallo", targetBundleId: nil)
        #expect(outcome.tier == .ax)
        #expect(outcome.ok)
        #expect(outcome.verification == .notPossible)
        #expect(unicode.calls.isEmpty)
    }

    @Test("an AX tier that proved its own write vanished still falls through")
    func axNotLandedFallsThrough() {
        // The AX tier reads the caret back *before* the fall-through, so its
        // "did not land" is a decline and the ladder answers it by typing the
        // text instead — the Arc recovery path. Treating it as terminal would
        // delete that.
        let (ladder, _, unicode) = self.ladder(
            ax: .notLanded(reason: "the selected range is still {12, 0}"),
            unicode: .confirmed
        )
        let outcome = ladder.run(text: "hallo", targetBundleId: nil)
        #expect(outcome.tier == .unicode)
        #expect(outcome.ok)
        #expect(unicode.calls == ["hallo"])
    }

    @Test("when both tiers fail the outcome is none, not ok, and explains both")
    func bothFail() {
        let (ladder, _, _) = self.ladder(
            ax: .failed(reason: "kAXErrorAPIDisabled (-25211)"),
            unicode: .failed(reason: "could not create a private CGEventSource")
        )
        let outcome = ladder.run(text: "hallo", targetBundleId: nil)
        #expect(outcome.tier == .none)
        #expect(outcome.ok == false)
        // Nothing was typed, so there was nothing to verify — `verified: null`,
        // not `false`. `false` is reserved for "we measured, and it is not
        // there", which is a stronger and different claim.
        #expect(outcome.verification == .notPossible)
        let error = outcome.error ?? ""
        #expect(error.contains("kAXErrorAPIDisabled"))
        #expect(error.contains("CGEventSource"))
        // IMPLEMENTATION-PLAN.md §4: errors carry actionable text.
        #expect(error.contains("Ctrl+Cmd+V"))
    }

    @Test("a moved target is declined without attempting either tier")
    func declinesOnTargetMismatch() {
        //  Typing into whatever is in front *now* is the
        // failure this check exists to prevent.
        let (ladder, ax, unicode) = self.ladder(
            ax: .succeeded,
            unicode: .succeeded,
            frontmost: "com.apple.Safari"
        )
        let outcome = ladder.run(text: "hallo", targetBundleId: "com.microsoft.VSCode")
        #expect(outcome.tier == .none)
        #expect(outcome.ok == false)
        #expect(ax.calls.isEmpty)
        #expect(unicode.calls.isEmpty)
        #expect(outcome.error?.contains("Notes") == true)
        // The prose above is for a human. This is what the app branches on:
        // without it, a focus change was indistinguishable from "neither tier
        // worked" and the HUD gave the wrong advice.
        #expect(outcome.reason == .targetChanged)
        #expect(outcome.verification == .notPossible)
    }

    @Test("a matching target inserts normally")
    func matchingTarget() {
        let (ladder, _, _) = self.ladder(ax: .succeeded, unicode: .succeeded)
        #expect(ladder.run(text: "hallo", targetBundleId: "com.apple.Notes").tier == .ax)
    }

    @Test("a null target skips the check entirely")
    func nullTargetSkipsCheck() {
        // Contract §3, and `state-machine.md` §6: Ctrl+Cmd+V deliberately sends
        // `targetBundleId: null`, because the whole point is to re-insert
        // wherever the user is now pointed.
        let (ladder, ax, _) = self.ladder(
            ax: .succeeded,
            unicode: .succeeded,
            frontmost: "com.apple.Safari"
        )
        #expect(ladder.run(text: "hallo", targetBundleId: nil).tier == .ax)
        #expect(ax.calls == ["hallo"])
    }

    @Test("a target check against an app with no bundle id declines")
    func unknownFrontmostDeclines() {
        let (ladder, ax, unicode) = self.ladder(
            ax: .succeeded,
            unicode: .succeeded,
            frontmost: nil
        )
        let outcome = ladder.run(text: "hallo", targetBundleId: "com.apple.Notes")
        #expect(outcome.tier == .none)
        #expect(outcome.reason == .targetChanged)
        #expect(ax.calls.isEmpty)
        #expect(unicode.calls.isEmpty)
    }

    @Test("empty text is refused before anything is attempted")
    func emptyText() {
        let (ladder, ax, unicode) = self.ladder(ax: .succeeded, unicode: .succeeded)
        let outcome = ladder.run(text: "", targetBundleId: nil)
        #expect(outcome.tier == .none)
        #expect(outcome.ok == false)
        #expect(outcome.reason == .emptyText)
        #expect(outcome.verification == .notPossible)
        #expect(ax.calls.isEmpty)
        #expect(unicode.calls.isEmpty)
    }

    @Test("the AX tier is handed the app the target check approved")
    func axTierReceivesTheResolvedApp() {
        // The pid on that value is what makes the AX tier work at all —
        // AXUIElementCreateApplication(pid) reaches the focused element where
        // AXUIElementCreateSystemWide() returns kAXErrorCannotComplete. Passing
        // the already-resolved app also means the tier cannot act on a
        // different application than the one the target check approved.
        let ax = StubAccessibilityInserter(result: .succeeded)
        let ladder = InsertionLadder(
            accessibility: ax,
            unicode: StubUnicodeInserter(result: .succeeded),
            frontmost: StubFrontmost(bundleId: "com.apple.Notes", name: "Notes", processId: 5012)
        )
        _ = ladder.run(text: "hallo", targetBundleId: "com.apple.Notes")
        #expect(ax.targets.count == 1)
        #expect(ax.targets[0].bundleId == "com.apple.Notes")
        #expect(ax.targets[0].processId == 5012)
    }

    @Test("a bundle id on the AX skip list goes straight to Unicode")
    func axSkipList() {
        // The escape hatch for an app that reports a successful AX write and
        // inserts nothing — see the note on `axSkipBundleIds`. Note the stub
        // here *succeeds*: if the skip did not happen, the tier would be `ax`.
        let ax = StubAccessibilityInserter(result: .succeeded)
        let unicode = StubUnicodeInserter(result: .succeeded)
        let ladder = InsertionLadder(
            accessibility: ax,
            unicode: unicode,
            frontmost: StubFrontmost(bundleId: "com.microsoft.VSCode", name: "Code"),
            axSkipBundleIds: ["com.microsoft.VSCode"]
        )
        let outcome = ladder.run(text: "hallo", targetBundleId: nil)
        #expect(outcome.tier == .unicode)
        #expect(ax.calls.isEmpty)
        #expect(unicode.calls == ["hallo"])
    }

    @Test("the skip list only affects the apps on it")
    func axSkipListIsScoped() {
        let ax = StubAccessibilityInserter(result: .succeeded)
        let ladder = InsertionLadder(
            accessibility: ax,
            unicode: StubUnicodeInserter(result: .succeeded),
            frontmost: StubFrontmost(bundleId: "com.apple.Notes", name: "Notes"),
            axSkipBundleIds: ["com.microsoft.VSCode"]
        )
        #expect(ladder.run(text: "hallo", targetBundleId: nil).tier == .ax)
        #expect(ax.calls == ["hallo"])
    }

    @Test("a skipped AX tier that then fails Unicode still explains both")
    func axSkipListBothFail() {
        let ladder = InsertionLadder(
            accessibility: StubAccessibilityInserter(result: .succeeded),
            unicode: StubUnicodeInserter(result: .failed(reason: "no event source")),
            frontmost: StubFrontmost(bundleId: "com.microsoft.VSCode", name: "Code"),
            axSkipBundleIds: ["com.microsoft.VSCode"]
        )
        let outcome = ladder.run(text: "hallo", targetBundleId: nil)
        #expect(outcome.tier == .none)
        #expect(outcome.error?.contains("GROK_DICTATE_AX_SKIP") == true)
        #expect(outcome.error?.contains("no event source") == true)
        #expect(outcome.reason == .noTier)
    }

    @Test("every AX decline is logged, carrying the evidence behind it")
    func declinesAreLogged() {
        // The *absence* of this line is what diagnosed the Arc bug: a 13.8 s
        // dictation produced an 11 ms insert with no "AX tier declined" line
        // anywhere, which is only possible if the AX tier returned .succeeded
        // (docs/phase-2-report.md §6.4, and `AXWriteVerification`). The line is
        // load-bearing diagnostics, so it is asserted rather than assumed.
        var logged: [(LogLevel, String)] = []
        let ladder = InsertionLadder(
            accessibility: StubAccessibilityInserter(
                result: .failed(
                    reason:
                        "via the application element, kAXSelectedTextAttribute reported settable "
                        + "and the write returned kAXErrorSuccess, but the selected range is "
                        + "still {12, 0}"
                )
            ),
            unicode: StubUnicodeInserter(result: .succeeded),
            frontmost: StubFrontmost(bundleId: "company.thebrowser.Browser", name: "Arc"),
            log: { level, message in logged.append((level, message)) }
        )

        let outcome = ladder.run(text: "hallo", targetBundleId: nil)
        #expect(outcome.tier == .unicode)
        #expect(outcome.ok)

        let declines = logged.filter { $0.1.contains("AX tier declined") }
        #expect(declines.count == 1)
        #expect(declines.first?.1.contains("still {12, 0}") == true)
    }

    @Test("perform() hands the same outcome to its completion")
    func performMatchesRun() {
        let (ladder, _, _) = self.ladder(ax: .succeeded, unicode: .succeeded)
        var received: InsertionOutcome?
        ladder.perform(text: "hallo", targetBundleId: nil) { received = $0 }
        #expect(received == ladder.run(text: "hallo", targetBundleId: nil))
    }
}
