/// The paste tier's decisions, exercised without a pasteboard.
///
/// Every branch below is a way the 2026-09-06 change can go wrong in the field
/// and be invisible: text typed twice, text left on the clipboard, a clipboard
/// manager's read mistaken for the user's paste. None of them raise an error
/// anywhere, so this file is the only place they get caught.

import Foundation
import Testing

@testable import HelperCore

@Suite("Paste transaction")
struct PasteTransactionTests {
    /// A transaction with the promise published and the chord posted, both at
    /// t=0 — the shape every real paste has by the time anything can happen.
    private func chorded() -> PasteTransaction {
        var tx = PasteTransaction(publishedAt: 0)
        tx.recordChord(at: 0)
        return tx
    }

    @Test("waits while nothing has happened")
    func waitsWhileNothingHasHappened() {
        let tx = chorded()
        #expect(tx.outcome(now: 0.1) == nil)
        #expect(tx.mayRelease(now: 0.1) == false)
    }

    @Test("a receipt after the chord lands immediately, and only then releases")
    func receiptAfterChordLands() {
        var tx = chorded()
        tx.recordTextReceipt(at: 0.03)

        // Reported at once: this is the moment the target has the text, and
        // waiting out the quiet period here would put 200 ms into the number
        // the whole change exists to reduce.
        #expect(tx.outcome(now: 0.03) == .landed)
        // …but the pasteboard stays up. Chromium probes and then reads.
        #expect(tx.mayRelease(now: 0.1) == false)
        #expect(tx.mayRelease(now: 0.23) == true)
    }

    @Test("every further read pushes the release out again")
    func lastReceiptWins() {
        var tx = chorded()
        tx.recordTextReceipt(at: 0.03)
        tx.recordTextReceipt(at: 0.15)
        // Quiet is measured from the last read, not the first — otherwise the
        // probe starts a clock that expires during the real read.
        #expect(tx.mayRelease(now: 0.23) == false)
        #expect(tx.mayRelease(now: 0.4) == true)
    }

    @Test("a read before the chord is a clipboard manager, not a paste")
    func receiptBeforeChordIsNotALanding() {
        var tx = PasteTransaction(publishedAt: 0)
        tx.recordTextReceipt(at: 0.01)  // reacting to the pasteboard change
        tx.recordChord(at: 0.02)

        #expect(tx.receiptsBeforeChord == 1)
        #expect(tx.receiptsAfterChord == 0)
        #expect(tx.outcome(now: 0.4) == nil)
        // …and it must not have started the release clock either, or the
        // transcript would be cleared before the target ever reads it.
        #expect(tx.mayRelease(now: 0.4) == false)
    }

    @Test("the transcript is not fulfilled until the chord, and not after settle")
    func shouldProvideTextTracksTheChord() {
        var tx = PasteTransaction(publishedAt: 0)
        #expect(tx.shouldProvideText == false)
        tx.recordChord(at: 0.05)
        #expect(tx.shouldProvideText == true)
        tx.markSettled()
        #expect(tx.shouldProvideText == false)
    }

    @Test("losing the pasteboard with nothing read falls through")
    func ownershipLostWithoutAReceipt() {
        var tx = chorded()
        tx.recordOwnershipLost()
        #expect(tx.outcome(now: 0.05) == .ownershipLost)
        // Released at once, so the ladder can inject without the pasteboard
        // still holding a transcript somebody might paste a second time.
        #expect(tx.mayRelease(now: 0.05) == true)
    }

    @Test("a receipt outranks losing the pasteboard afterwards")
    func receiptBeatsLaterOwnershipLoss() {
        var tx = chorded()
        tx.recordTextReceipt(at: 0.03)
        tx.recordOwnershipLost()
        // The target read our text and *then* the user copied something. The
        // paste landed. Reporting `ownershipLost` here would fall through to
        // injection and type the transcript twice — the single outcome this
        // design exists to prevent.
        #expect(tx.outcome(now: 0.04) == .landed)
    }

    @Test("a chord that could not be posted gives up after the grace period")
    func chordFailureGivesUp() {
        var tx = PasteTransaction(publishedAt: 0)
        tx.recordChordFailure(at: 0)
        #expect(tx.outcome(now: 0.4) == nil)
        #expect(tx.outcome(now: 0.5) == .chordFailed)
        #expect(tx.mayRelease(now: 0.5) == true)
    }

    @Test("nothing ever reads it, so it times out at the ceiling")
    func timesOut() {
        let tx = chorded()
        #expect(tx.outcome(now: 0.49) == nil)
        #expect(tx.mayRelease(now: 0.49) == false)
        #expect(tx.outcome(now: 0.5) == .timedOut)
        #expect(tx.mayRelease(now: 0.5) == true)
    }

    @Test("the ceiling releases even under a stream of reads")
    func ceilingBeatsAStreamOfReceipts() {
        var tx = chorded()
        for tick in stride(from: 0.05, through: 0.6, by: 0.05) { tx.recordTextReceipt(at: tick) }
        // Quiet would never arrive; the transcript must not live on the
        // clipboard indefinitely because something keeps polling it.
        #expect(tx.mayRelease(now: 0.6) == true)
    }

    @Test("settling makes every later event a no-op")
    func settlingIsFinal() {
        var tx = chorded()
        tx.recordTextReceipt(at: 0.03)
        tx.markSettled()

        // `clearContents()` fires `pasteboardChangedOwner:` on the process that
        // called it, so our own release arrives looking exactly like the user
        // copying something else (measured 2026-09-06, report §9.5). Without
        // this the settle path runs twice on every successful paste.
        tx.recordOwnershipLost()
        #expect(tx.ownershipLost == false)
        tx.recordTextReceipt(at: 0.25)
        #expect(tx.receiptsAfterChord == 1)
        #expect(tx.mayRelease(now: 0.3) == false)
    }

    @Test("a transaction settled from outside still answers, rather than waiting forever")
    func settlingFromOutsideResolvesTheWait() {
        // `HelperApp.shutdown` takes the pasteboard back so that quitting cannot
        // leave the transcript on it — and it can do that while the insertion
        // queue is still inside its wait loop. `outcome` answering `nil` there
        // spins that queue until the process dies.
        var pending = chorded()
        pending.markSettled()
        #expect(pending.outcome(now: 0.1) == .abandoned)

        // …and one that had already been read reports the truth, not the
        // shutdown: the target has the text.
        var landed = chorded()
        landed.recordTextReceipt(at: 0.03)
        landed.markSettled()
        #expect(landed.outcome(now: 0.1) == .landed)
    }

    @Test("a receipt that slips in before the clear turns a give-up into a landing")
    func verdictUpgradesALateReceipt() {
        var tx = chorded()
        // Decided to give up…
        #expect(tx.outcome(now: 0.5) == .timedOut)
        // …and the target read it in the window before `clearContents()` ran.
        // The inserter drains the runloop before asking, so a `provideDataForType:`
        // that was already queued is visible here rather than dropped by settle.
        tx.recordTextReceipt(at: 0.501)
        #expect(tx.verdict(after: .timedOut) == .landed)
    }

    @Test("a give-up with nothing read stays a give-up")
    func verdictLeavesARealFailureAlone() {
        var tx = chorded()
        tx.recordOwnershipLost()
        #expect(tx.verdict(after: .ownershipLost) == .ownershipLost)
        #expect(PasteTransaction(publishedAt: 0).verdict(after: .timedOut) == .timedOut)
    }
}
