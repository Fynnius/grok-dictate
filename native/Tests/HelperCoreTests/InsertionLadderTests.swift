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
        let (ladder, ax, unicode) = self.ladder(ax: .succeeded, unicode: .succeeded)
        let outcome = ladder.run(text: "hallo", targetBundleId: nil)
        #expect(outcome.tier == .ax)
        #expect(outcome.ok)
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
        #expect(outcome.error == nil)
        #expect(ax.calls == ["hallo"])
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
