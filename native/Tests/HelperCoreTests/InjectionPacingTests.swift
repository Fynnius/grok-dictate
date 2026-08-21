/// The pacing decision, which is BUG-1's other half.
///
/// The incident is reproducible here as arithmetic and nowhere else: what the
/// tier does with 760 UTF-16 units is a question about a pure function, and the
/// answer used to be "38 events in 245 ms". These tests pin the two properties
/// that matter — long text slows down, short text does not — plus the escape
/// hatch, whose whole value is that it still wins.

import Foundation
import Testing

@testable import HelperCore

@Suite("Injection pacing")
struct InjectionPacingTests {
    /// What `Settings.fromEnvironment` produces with nothing set.
    private let shipped = InjectionPacer.Baseline(
        chunkUnits: 20,
        interChunkDelay: 0.005,
        delayIsExplicit: false
    )

    // MARK: - Short text keeps today's timing

    @Test("a short insert is paced exactly as it was before")
    func shortTextIsUnchanged() {
        // The 11-unit reply that lands fine today must go on landing instantly.
        // Fixing the long case by slowing every case down would trade a rare
        // data loss for a permanent regression in the common one.
        for count in [1, 11, 42, 79, 199, 200] {
            let pacing = InjectionPacer.pacing(forUTF16Count: count, baseline: shipped)
            #expect(pacing.interChunkDelay == 0.005, "\(count) units should not be slowed")
            #expect(pacing.chunkUnits == 20)
            #expect(pacing.isPacedForLength == false)
        }
    }

    @Test("42, 49 and 79 units — the three that landed in cmux — are untouched")
    func theInsertsThatWorked() {
        // From the same log as the failure, into the same application on the
        // same day. They are the control group, and the fix must not move them.
        for count in [42, 49, 79] {
            #expect(InjectionPacer.pacing(forUTF16Count: count, baseline: shipped).interChunkDelay == 0.005)
        }
    }

    // MARK: - Long text slows down

    @Test("above the threshold the delay rises to the long-text value")
    func longTextIsSlowed() {
        let pacing = InjectionPacer.pacing(forUTF16Count: 201, baseline: shipped)
        #expect(pacing.interChunkDelay == InjectionPacer.longTextInterChunkDelay)
        #expect(pacing.isPacedForLength)
    }

    @Test("the 760-unit insertion that was dropped is paced at 15 ms")
    func theIncident() {
        // 760 UTF-16 units, 38 events, ~245 ms, silently dropped by cmux while
        // the HUD showed a green "Inserted" pill.
        let pacing = InjectionPacer.pacing(forUTF16Count: 760, baseline: shipped)
        #expect(pacing.interChunkDelay == 0.015)

        // The cost, asserted rather than described: 38 chunks, 37 gaps, ~555 ms
        // of pacing where there used to be ~185 ms. Well inside the app's 15 s
        // INSERT_TIMEOUT_MS, which is the budget this trade is made against.
        let chunks = TextChunker.chunks(
            of: String(repeating: "a", count: 760),
            maxUTF16Units: pacing.chunkUnits
        )
        #expect(chunks.count == 38)
        let paced = Double(chunks.count - 1) * pacing.interChunkDelay
        #expect(paced < 0.6)
        #expect(paced > 0.5)
    }

    @Test("the chunk size is deliberately not shrunk")
    func chunkIsUntouched() {
        // Halving the chunk would double the number of events, which is the
        // variable under suspicion — the burst would get longer, not safer.
        // 20 units is also what Phase 2 measured landing byte-identically in six
        // applications (native/probe-out/*.log).
        for count in [10, 500, 5_000] {
            #expect(InjectionPacer.pacing(forUTF16Count: count, baseline: shipped).chunkUnits == 20)
        }
    }

    @Test("pacing never gets faster than the baseline")
    func neverSpeedsUp() {
        // A baseline slower than the long-text delay is somebody's deliberate
        // default; this rule exists to slow injections down, never to speed one
        // up.
        let slow = InjectionPacer.Baseline(
            chunkUnits: 20,
            interChunkDelay: 0.05,
            delayIsExplicit: false
        )
        let pacing = InjectionPacer.pacing(forUTF16Count: 5_000, baseline: slow)
        #expect(pacing.interChunkDelay == 0.05)
        #expect(pacing.isPacedForLength == false)
    }

    // MARK: - The escape hatch stays authoritative

    @Test("an explicit GROK_DICTATE_INJECT_DELAY_MS wins at every length")
    func explicitDelayWins() {
        // The knob exists so the value can be swept against a real application
        // in one sitting rather than one rebuild per attempt (Settings.swift).
        // A rule that quietly overrode it would take that away.
        let explicit = InjectionPacer.Baseline(
            chunkUnits: 20,
            interChunkDelay: 0.001,
            delayIsExplicit: true
        )
        for count in [10, 201, 760, 10_000] {
            let pacing = InjectionPacer.pacing(forUTF16Count: count, baseline: explicit)
            #expect(pacing.interChunkDelay == 0.001, "\(count) units should honour the override")
            #expect(pacing.isPacedForLength == false)
        }
    }

    @Test("zero is a legal explicit delay and is honoured")
    func explicitZero() {
        let none = InjectionPacer.Baseline(
            chunkUnits: 20,
            interChunkDelay: 0,
            delayIsExplicit: true
        )
        #expect(InjectionPacer.pacing(forUTF16Count: 5_000, baseline: none).interChunkDelay == 0)
    }

    @Test("an explicit chunk size is honoured, since pacing never touches it")
    func explicitChunk() {
        let baseline = InjectionPacer.Baseline(
            chunkUnits: 5,
            interChunkDelay: 0.005,
            delayIsExplicit: false
        )
        let pacing = InjectionPacer.pacing(forUTF16Count: 760, baseline: baseline)
        #expect(pacing.chunkUnits == 5)
        #expect(pacing.interChunkDelay == 0.015)
    }

    @Test("the summary says both numbers, because a slow insert must be explicable")
    func summary() {
        let pacing = InjectionPacer.pacing(forUTF16Count: 760, baseline: shipped)
        #expect(pacing.summary.contains("20"))
        #expect(pacing.summary.contains("15 ms"))
    }
}
