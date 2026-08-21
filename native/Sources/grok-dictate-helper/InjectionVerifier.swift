/// The Unicode tier's evidence: what the target's text length did while we typed
/// into it.
///
/// `UnicodeWriteVerification` in HelperCore holds the *decision* — grew, did not
/// change, cannot tell — and is a pure function of three integers so that
/// `swift test` can exercise every branch of it without a windowserver. This
/// file is the part that cannot be tested that way: the AX reads that produce
/// those integers, and the polling loop around them.
///
/// **Why this can work in the applications where the AX tier cannot.** The AX
/// tier declines for a terminal because `kAXSelectedTextAttribute` is not
/// *settable* — but the element is still an `AXTextArea` and its contents are
/// still *readable*. Refusing to write and refusing to read are different
/// refusals, and BUG-1 turned on nobody having tried the second one. The screen
/// buffer of a terminal is exactly the thing that grows when characters arrive
/// in it.
///
/// **The budget, and why it is bounded by construction.** Verification must not
/// add more than ~300 ms to an insert. So it is split in two halves with a
/// deadline each, and every AX read's messaging timeout is clamped to whatever
/// is left of its half — an application that stops answering cannot stall the
/// insertion queue behind it:
///
///   - before typing: resolve the element, read a length, read the selection,
///     ≤ 100 ms for all of it together;
///   - after typing:  polled every 20 ms for ≤ 200 ms, exiting the moment the
///     text is confirmed.
///
/// One path exceeds that, deliberately: the verdict that says "your text is not
/// there" spends one more element resolution (≤ 100 ms) checking that focus did
/// not move out from under the measurement. It is the only verdict that can
/// accuse a target of dropping the dictation, it is rare, and being wrong about
/// it is worse than being slow.
///
/// On the path that matters — the text landed — the loop exits on its first or
/// second read, so the cost is two AX round trips. `--probe-ax` prints those in
/// milliseconds for any app you point it at; they were single-digit in every app
/// Phase 2 measured.
///
/// Polling rather than one sleep-then-look is the incident report's instruction
/// and is also the cheaper of the two: a fixed 150 ms sleep would cost 150 ms on
/// every long insert, where polling costs one read.
///
/// **Where this runs.** On `BackgroundInsertion`'s serial queue, never the main
/// thread — same discipline as the paced injection it follows, and for the same
/// reason: blocking the main run loop stalls the `CGEventTap` callback until
/// macOS disables the tap. Nothing here may be moved onto the main thread
/// without re-reading the note at the top of `HelperApp.swift`.

import ApplicationServices
import Foundation
import HelperCore

enum InjectionVerifier {
    /// The ceiling on a single AX read, and the two halves of the budget. All
    /// **chosen, not measured**: they divide up the ~300 ms this is allowed to
    /// cost rather than describing any application's observed latency. The reads
    /// themselves were single-digit milliseconds everywhere `--probe-ax` has
    /// been pointed, so in practice none of these numbers is reached.
    private static let readTimeout: TimeInterval = 0.1
    private static let preTypingBudget: TimeInterval = 0.1
    private static let postTypingBudget: TimeInterval = 0.2
    private static let pollInterval: TimeInterval = 0.02

    /// Clamp the next message to this element to whatever is left of a deadline.
    ///
    /// The floor keeps a nearly-expired budget from turning into a zero timeout,
    /// which AX documents as "wait forever" — the one value that would defeat
    /// the entire point of bounding this.
    private static func limitNextRead(of element: AXUIElement, to deadline: Date) {
        let remaining = deadline.timeIntervalSinceNow
        AXUIElementSetMessagingTimeout(element, Float(max(0.01, min(readTimeout, remaining))))
    }

    /// Which attribute a length came from. Recorded because the before and after
    /// reads **must** come from the same one: `kAXNumberOfCharacters` and the
    /// length of `kAXValue` need not agree, and a delta taken across the two
    /// would be an artefact rather than a measurement.
    enum LengthSource {
        /// Preferred: one integer across the process boundary.
        case numberOfCharacters
        /// Fallback. This copies the *entire* document into this process, which
        /// `AXWriteVerification` rejects for the AX tier's per-insert path on
        /// exactly the grounds that it is slow in a large field and is somebody
        /// else's text. It is accepted here, once before and once per poll,
        /// because without it a target that does not implement
        /// `kAXNumberOfCharacters` cannot be verified at all — and because only
        /// `.utf16.count` is ever taken from it. The string is not logged, not
        /// stored, and not compared against anything.
        case value

        var description: String {
            switch self {
            case .numberOfCharacters: return "kAXNumberOfCharacters"
            case .value: return "the length of kAXValue"
            }
        }

        func length(of element: AXUIElement) -> Int? {
            var value: CFTypeRef?
            switch self {
            case .numberOfCharacters:
                let error = AXUIElementCopyAttributeValue(
                    element,
                    kAXNumberOfCharactersAttribute as CFString,
                    &value
                )
                guard error == .success, let number = value as? Int else { return nil }
                return number
            case .value:
                let error = AXUIElementCopyAttributeValue(
                    element,
                    kAXValueAttribute as CFString,
                    &value
                )
                guard error == .success, let string = value as? String else { return nil }
                return string.utf16.count
            }
        }
    }

    /// Everything the after-check needs, captured before a single event is
    /// posted. Holding the `AXUIElement` — rather than re-resolving focus later
    /// — is what makes the two lengths comparable.
    struct Measurement {
        let element: AXUIElement
        let source: LengthSource
        let before: Int
        /// UTF-16 length of whatever was selected when we started. Typing
        /// replaces a selection, so the field grows by (typed − selected), and
        /// assuming zero here is how a clean replacement of N characters by N
        /// characters would be misread as "nothing arrived".
        let selectionUTF16Length: Int
        /// False when `kAXSelectedTextRange` could not be read and the zero
        /// above is an assumption rather than a measurement. Carried into the
        /// evidence string so a wrong "did not land" can be recognised as this.
        let selectionWasMeasured: Bool
    }

    enum Preparation {
        case ready(Measurement)
        /// Nothing here can be measured — no focus, no readable length, or
        /// verification switched off. The tier reports `ok: true, verified: null`.
        case notPossible(String)
    }

    static func prepare(for app: FrontmostAppInfo) -> Preparation {
        guard AXIsProcessTrusted() else {
            return .notPossible(
                "Accessibility permission is not granted, so nothing can be read back"
            )
        }

        // One deadline for everything before the first key event: the element
        // resolution, the length probes and the selection read all draw on it.
        let deadline = Date().addingTimeInterval(preTypingBudget)

        let element: AXUIElement
        switch focusedElement(of: app, by: deadline) {
        case let .success(found): element = found
        case let .failure(reason): return .notPossible(reason)
        }

        // Preference order, not a fallback chain that mixes: whichever answers
        // first is the source *both* reads use, because a delta taken across two
        // different attributes would be an artefact.
        var measured: (source: LengthSource, length: Int)?
        for candidate in [LengthSource.numberOfCharacters, .value] {
            limitNextRead(of: element, to: deadline)
            if let length = candidate.length(of: element) {
                measured = (candidate, length)
                break
            }
        }
        guard let (source, before) = measured else {
            return .notPossible(
                "the focused element reports neither kAXNumberOfCharacters nor a readable kAXValue"
            )
        }

        limitNextRead(of: element, to: deadline)
        let selection = copySelectedRange(of: element)
        return .ready(
            Measurement(
                element: element,
                source: source,
                before: before,
                selectionUTF16Length: selection.range?.length ?? 0,
                selectionWasMeasured: selection.range != nil
            )
        )
    }

    /// Poll the length until it has grown by what was typed, or the budget runs
    /// out.
    ///
    /// The early exit is the pure verdict function itself, so the loop cannot
    /// disagree with the conclusion: the same `UnicodeWriteVerification.verdict`
    /// that decides at the end decides whether to stop early.
    static func confirm(_ measurement: Measurement, typedUTF16Units typed: Int) -> UnicodeWriteVerdict {
        let expected = typed - measurement.selectionUTF16Length
        let deadline = Date().addingTimeInterval(postTypingBudget)

        var lastLength: Int?
        var aReadFailed = false

        while true {
            // Clamped to what is left of the budget, so the worst case is the
            // budget plus one read rather than the budget times the poll count.
            limitNextRead(of: measurement.element, to: deadline)

            if let length = measurement.source.length(of: measurement.element) {
                lastLength = length
                let verdict = UnicodeWriteVerification.verdict(
                    before: measurement.before,
                    after: length,
                    expectedGrowthUTF16Units: expected
                )
                if UnicodeWriteVerification.confirmsInsertion(verdict) { return verdict }
            } else {
                // One failed read is enough to give up the strongest claim: a
                // length we could not read is not a length that did not change.
                aReadFailed = true
            }

            let left = deadline.timeIntervalSinceNow
            if left <= 0 { break }
            Thread.sleep(forTimeInterval: min(pollInterval, left))
        }

        let verdict = UnicodeWriteVerification.verdict(
            before: measurement.before,
            after: aReadFailed ? nil : lastLength,
            expectedGrowthUTF16Units: expected
        )
        guard verdict.provesNothingLanded else { return verdict }

        // Everything below only runs on the one verdict that is allowed to tell
        // the user their text is missing. It is worth an extra AX read to be
        // sure, because a false "not inserted" is a new failure mode worse than
        // the one this fix is for: it fires an error cue over text that is on
        // screen and invites a ⌃⌘V that types it a second time.
        switch focusedElementStillIs(measurement.element) {
        case let .failure(reason):
            return .unverifiable(
                evidence:
                    "the field did not grow, but the focused element could no longer be confirmed "
                    + "as the one that was measured (\(reason)), so this proves nothing"
            )
        case .success:
            break
        }

        guard measurement.selectionWasMeasured else {
            return .didNotLand(
                evidence:
                    verdict.evidence
                    + " (its selection could not be read before typing, so this assumes nothing "
                    + "was selected)"
            )
        }
        return verdict
    }

    // MARK: - AX plumbing

    /// The same two routes, in the same order, as the AX tier: the application
    /// element first because Phase 2 measured it as the only one that reaches a
    /// focused element on macOS 26 (`AXInserter`), system-wide as the cheap
    /// fallback.
    private static func focusedElement(
        of app: FrontmostAppInfo,
        by deadline: Date
    ) -> AXFocusedElementRead {
        var failures: [String] = []

        if let processId = app.processId {
            let application = AXUIElementCreateApplication(processId)
            limitNextRead(of: application, to: deadline)
            switch copyFocusedElement(of: application) {
            case let .success(element): return .success(element)
            case let .failure(reason): failures.append("application element: \(reason)")
            }
        } else {
            failures.append("application element: the frontmost app reported no pid")
        }

        let systemWide = AXUIElementCreateSystemWide()
        limitNextRead(of: systemWide, to: deadline)
        switch copyFocusedElement(of: systemWide) {
        case let .success(element): return .success(element)
        case let .failure(reason): failures.append("system-wide: \(reason)")
        }

        return .failure("no focused element to measure (\(failures.joined(separator: "; ")))")
    }

    /// Is the element we measured still the focused one?
    ///
    /// A paced injection of a long transcript takes hundreds of milliseconds, and
    /// the user is free to click somewhere else in the middle of it. If they did,
    /// the length we are comparing belongs to a field nobody typed into — which
    /// would read exactly like "nothing arrived".
    ///
    /// The one read that is outside the ~300 ms budget, and the header says why:
    /// it guards the only verdict that tells the user their dictation is missing.
    private static func focusedElementStillIs(_ element: AXUIElement) -> AXFocusedElementRead {
        var pid: pid_t = 0
        guard AXUIElementGetPid(element, &pid) == .success else {
            return .failure("the measured element no longer reports a pid")
        }
        let application = AXUIElementCreateApplication(pid)
        limitNextRead(of: application, to: Date().addingTimeInterval(readTimeout))
        switch copyFocusedElement(of: application) {
        case let .success(current):
            guard CFEqual(current, element) else {
                return .failure("focus moved to another element while the text was being typed")
            }
            return .success(current)
        case let .failure(reason):
            return .failure(reason)
        }
    }
}
