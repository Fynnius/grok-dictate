/// Diagnostic modes that exist because three of Phase 2's five human tests
/// cannot be automated, and running them through the whole Electron app would
/// make each one a multi-minute ritual.
///
/// In these modes stdout is **human text, not protocol**. That is safe because
/// nothing spawns the helper with a `--probe-*` argument; contract §1's "the
/// helper must not write anything to stdout that is not a frame" applies to
/// protocol mode, which is the argument-free default.
///
/// | Mode                 | Answers                                                        |
/// | -------------------- | -------------------------------------------------------------- |
/// | `--probe-tap`        | plan §3.2 test 2 — Fn press/release timing                     |
/// | `--probe-insert`     | plan §3.2 test 3,  — the per-app tier table      |
/// | `--probe-ax`         | which AX route works here, and whether this app lies about it  |
/// | `--probe-secure-ax`  | plan §3.2 test 5,  — AX under Secure Input       |
///
/// **Caveat, and it must be stated wherever these results are recorded:** run
/// from a terminal, this binary inherits the *terminal's* TCC grants, not
/// Electron's. That is fine for the questions above — which tier handles which
/// app, and whether the bytes survive, do not depend on which process holds the
/// grant — but it means these modes cannot answer assumption 10.5. Only the
/// real app can.

import AppKit
import ApplicationServices
import Carbon.HIToolbox
import CoreGraphics
import Foundation
import HelperCore

enum Probes {
    /// Exactly 300 extended grapheme clusters (317 UTF-16 units, 372 UTF-8
    /// bytes), as IMPLEMENTATION-PLAN.md §3.2 test 3 asks for. Chosen to break
    /// things that plausibly break:
    ///
    /// - German umlauts and `ß`, in both cases;
    /// - `„…"` typographic quotes and an en dash, which some input paths mangle;
    /// - the ASCII punctuation block, which is what corrupts shell commands
    ///;
    /// - `👍🏽` (skin-tone modifier), `👨‍👩‍👧‍👦` (ZWJ sequence) and `🇩🇪` (regional
    ///   indicator pair) — the three shapes that a UTF-16 chunker splits
    ///   incorrectly if it counts units instead of graphemes.
    static let injectionFixture =
        #"Grüße aus München! Wir haben das Feature heute früh auf dem Staging-Server deployed — Größe 1.234,56 €, Übergabe um 14:30 Uhr. Straße, Fußgängerzone, Öffnungszeiten: täglich 9–18 Uhr. „Alles klar?" fragte Jörg. Zeichen: äöüÄÖÜß @#$%^&*()_+-=[]{}|;:'",.<>/?`~ 👍🏽 👨‍👩‍👧‍👦 🇩🇪 🚀 ✅ Ende der Prüfung, Zeile 42/999."#

    // MARK: - Tap

    static func runTapProbe(settings: Settings, forceDisableAfter: TimeInterval?) -> Never {
        let recognizer = HotkeyRecognizer()
        var lastDownMs: Int?

        let controller = EventTapController(
            recognizer: recognizer,
            log: { level, message in report("[\(level.rawValue)] \(message)") },
            onActions: { actions, timestampMs in
                for action in actions {
                    var suffix = ""
                    if action == .pttDown { lastDownMs = timestampMs }
                    if action == .pttUp, let down = lastDownMs {
                        suffix = "   (held \(timestampMs - down) ms)"
                    }
                    report("\(stamp(timestampMs))  \(action.rawValue)\(suffix)")
                }
            }
        )

        report("Grok Dictate helper \(helperVersion) — tap probe")
        report("Accessibility trusted: \(isAccessibilityTrusted(prompt: settings.promptForAccessibility))")
        report("Secure Input active:   \(IsSecureEventInputEnabled())")
        do {
            try controller.install(watchdogInterval: settings.tapWatchdogInterval)
        } catch {
            let detail = (error as? EventTapController.InstallError)?.description ?? "\(error)"
            report("FAILED to install the tap — \(detail)")
            exit(1)
        }
        report("Tap installed. Hold Fn, tap Fn+Space, press Ctrl+Cmd+V. Ctrl+C to stop.")

        if let forceDisableAfter {
            scheduleForcedDisable(controller: controller, after: forceDisableAfter, settings: settings)
        }

        report("")
        CFRunLoopRun()
        exit(0)
    }

    /// Kill the tap the way macOS does, and watch the watchdog bring it back.
    ///
    /// IMPLEMENTATION-PLAN.md §5b: "Tap survives `kCGEventTapDisabledByTimeout`
    /// — **force it, don't assume**". `TapHealthTests` forces the *logic*
    /// against a fake handle, which is worth having but proves nothing about a
    /// real `CFMachPort` on a real windowserver. This disables the live tap and
    /// then reports, second by second, whether it comes back — the observable
    /// half of , whose whole point is that the failure is
    /// otherwise invisible until hours of uptime have passed.
    ///
    /// Note the asymmetry with the real failure: macOS also delivers a
    /// `.tapDisabledByTimeout` event, which the reactive path in
    /// `EventTapController.handle` acts on immediately. Disabling the tap from
    /// outside delivers no such event, so what this exercises is the **5-second
    /// watchdog** — deliberately, because that is the backstop nobody would
    /// otherwise ever see run.
    private static func scheduleForcedDisable(
        controller: EventTapController,
        after: TimeInterval,
        settings: Settings
    ) {
        report("")
        report("Will force-disable the tap in \(Int(after))s, then watch it recover.")
        DispatchQueue.main.asyncAfter(deadline: .now() + after) {
            controller.setEnabled(false)
            report("\(stamp())  FORCED the tap off — enabled: \(controller.isEnabled)")
            report(
                "\(stamp())  watchdog interval is \(Int(settings.tapWatchdogInterval * 1000)) ms; "
                + "recovery should be reported below"
            )

            var elapsed: TimeInterval = 0
            let step: TimeInterval = 0.5
            let deadline = settings.tapWatchdogInterval * 3 + 1
            func poll() {
                elapsed += step
                if controller.isEnabled {
                    report("\(stamp())  RECOVERED after \(Int(elapsed * 1000)) ms — press Fn to confirm it works")
                    return
                }
                if elapsed >= deadline {
                    report("\(stamp())  STILL DEAD after \(Int(elapsed * 1000)) ms — this is a FAILURE")
                    return
                }
                DispatchQueue.main.asyncAfter(deadline: .now() + step) { poll() }
            }
            DispatchQueue.main.asyncAfter(deadline: .now() + step) { poll() }
        }
    }

    // MARK: - Insertion

    struct InsertOptions {
        var countdownSeconds = 5
        var tier: String = "auto"  // auto | ax | unicode
        var text: String = Probes.injectionFixture
        var outputPath = "probe-out/expected.txt"
    }

    static func runInsertProbe(settings: Settings, options: InsertOptions) -> Never {
        report("Grok Dictate helper \(helperVersion) — insertion probe")
        report("Tier under test:  \(options.tier)")
        // If this is false the AX tier cannot possibly win, and the whole run
        // says nothing about the app under test.
        report(
            "Accessibility:    \(isAccessibilityTrusted(prompt: settings.promptForAccessibility) ? "trusted" : "NOT TRUSTED")"
        )
        report(
            "Text:             \(options.text.count) characters, "
                + "\(options.text.utf16.count) UTF-16 units, "
                + "\(options.text.utf8.count) UTF-8 bytes"
        )
        // What the ladder will *actually* use, not the baseline: since BUG-1 the
        // delay depends on the length printed above, and a probe that reported
        // the baseline would misdescribe the very run it is measuring.
        let pacing = InjectionPacer.pacing(
            forUTF16Count: options.text.utf16.count,
            baseline: settings.injectionBaseline
        )
        report(
            "Chunking:         \(pacing.summary)"
                + (pacing.isPacedForLength ? " (paced for length)" : "")
                + ", tap=\(settings.injectTap == .cghidEventTap ? "hid" : "session")"
        )
        report("Verification:     \(settings.verifyUnicodeWrites ? "on" : "off (GROK_DICTATE_INJECT_VERIFY)")")

        switch writeExpectedFile(text: options.text, path: options.outputPath) {
        case let .success(path):
            report("Expected output:  \(path)")
        case let .failure(message):
            report("Expected output:  could not be written (\(message))")
        }

        let workspace = WorkspaceMonitor { _ in }
        let log: (LogLevel, String) -> Void = { level, message in
            report("[\(level.rawValue)] \(message)")
        }
        let unicodeInserter = UnicodeInserter(settings: settings, log: log)
        let disabled = DryRunInserter()

        // The ladder's own log is wired up here on purpose. It carries the
        // reason the AX tier declined — the real `AXError`, by name and number
        // — and that is the evidence  and §9.7 are asking for.
        // Without it, an app that falls through to Unicode looks identical to
        // an app the AX tier was never offered, which is the difference between
        // "AX does not support this app" and "our AX call is wrong".
        let ladder: InsertionLadder
        switch options.tier {
        case "ax":
            ladder = InsertionLadder(
                accessibility: AXInserter(verifyWrites: settings.verifyAXWrites, log: log),
                unicode: disabled,
                frontmost: workspace,
                axSkipBundleIds: settings.axSkipBundleIds,
                log: log
            )
        case "unicode":
            // Skipping AX by forcing its stub to fail, so the recorded outcome
            // reads `tier: unicode` — which is what the per-app table needs.
            ladder = InsertionLadder(
                accessibility: disabled,
                unicode: unicodeInserter,
                frontmost: workspace,
                log: log
            )
        default:
            ladder = InsertionLadder(
                accessibility: AXInserter(verifyWrites: settings.verifyAXWrites, log: log),
                unicode: unicodeInserter,
                frontmost: workspace,
                axSkipBundleIds: settings.axSkipBundleIds,
                log: log
            )
        }

        report("")
        report("Switch to the target app and put the caret in a text field.")
        for remaining in stride(from: options.countdownSeconds, through: 1, by: -1) {
            report("  injecting in \(remaining)…")
            Thread.sleep(forTimeInterval: 1)
        }

        let target = workspace.frontmostApp
        report("")
        report("Frontmost at injection: \(target.name ?? "?") (\(target.bundleId ?? "no bundle id"))")

        let started = Date()
        // `targetBundleId: nil` disables the frontmost check — this probe is
        // pointed by hand, so there is nothing to compare against.
        let outcome = ladder.run(text: options.text, targetBundleId: nil)
        let elapsedMs = Int(Date().timeIntervalSince(started) * 1000)

        report("")
        report("tier:     \(outcome.tier.rawValue)")
        report("ok:       \(outcome.ok)")
        // The field the app now branches on: `ok: true` with `verified` not true
        // is "typed, unconfirmed", and this probe is where that is easiest to
        // see against a real application.
        report(
            "verified: "
                + (outcome.verification.wireValue.map(String.init(describing:)) ?? "null (could not be checked)")
        )
        report("reason:   \(outcome.reason?.rawValue ?? "none")")
        report("error:    \(outcome.error ?? "none")")
        report("elapsed:  \(elapsedMs) ms")
        report("")
        report("Now copy what actually landed in the app into a file and run:")
        report("  ./verify-insert.sh <that-file>")
        exit(outcome.ok ? 0 : 1)
    }

    private enum WriteResult {
        case success(String)
        case failure(String)
    }

    private static func writeExpectedFile(text: String, path: String) -> WriteResult {
        let url = URL(fileURLWithPath: path)
        do {
            try FileManager.default.createDirectory(
                at: url.deletingLastPathComponent(),
                withIntermediateDirectories: true
            )
            // No trailing newline: the comparison is against exactly what was
            // injected, and an invented `\n` would show up as a spurious diff.
            try Data(text.utf8).write(to: url)
            return .success(url.path)
        } catch {
            return .failure("\(error)")
        }
    }

    // MARK: - Which AX route actually reaches the focused element, and does it lie

    /// Diagnostic for a result the Phase 2 human tests turned up: every app
    /// tested — including Notes and TextEdit, which  predicts the
    /// AX tier handles — returned `kAXErrorCannotComplete (-25204)` from
    /// `kAXFocusedUIElementAttribute` on the **system-wide** element, while
    /// `AXIsProcessTrusted()` reported true.
    ///
    /// A uniform failure across native and Electron apps alike is evidence
    /// about *our call*, not about the apps. This tries the plausible routes
    /// side by side so the fix is chosen from a measurement rather than from a
    /// guess about which one macOS 26 prefers.
    ///
    /// **Phase 5 widened it into the general "does this app lie?" instrument**,
    /// because the way Arc's silent data loss was found — reading state-machine
    /// timings out of an app log and noticing an 11 ms insert and a *missing*
    /// log line — does not scale to the next application. One run now prints
    /// every input to the AX tier's decision: the frontmost app, the focused
    /// element's role and subrole, whether `kAXSelectedTextAttribute` is
    /// settable, the selected range before and after a real test write, the
    /// `AXError` from each call, and what `AXWriteVerification` concludes from
    /// all of it — reusing the shipping policy rather than a copy of it, so the
    /// probe cannot agree with a helper that would have behaved differently.
    ///
    /// It also reads `kAXNumberOfCharacters` and the length of `kAXValue`, which
    /// the insertion path deliberately does not: they are a second and third
    /// independent signal, and a probe run by hand can afford a whole-document
    /// copy that a 160 ms insertion budget cannot. Only *lengths* are printed —
    /// the value of somebody's text field is not this tool's business
    ///.
    static func runAXRouteProbe(settings: Settings, countdownSeconds: Int) -> Never {
        report("Grok Dictate helper \(helperVersion) — AX route probe")
        report("Accessibility trusted: \(isAccessibilityTrusted(prompt: settings.promptForAccessibility))")
        report("Secure Input active:   \(IsSecureEventInputEnabled())")
        report("")
        report("Switch to the app and put the caret in a text field.")
        for remaining in stride(from: countdownSeconds, through: 1, by: -1) {
            report("  probing in \(remaining)…")
            Thread.sleep(forTimeInterval: 1)
        }
        report("")

        guard let app = NSWorkspace.shared.frontmostApplication else {
            report("no frontmost application")
            exit(1)
        }
        report("Frontmost: \(app.localizedName ?? "?") (\(app.bundleIdentifier ?? "no bundle id")), pid \(app.processIdentifier)")
        report("")

        var winner: (name: String, element: AXUIElement)?

        for route in AXRoute.all {
            let (element, detail) = route.focusedElement(pid: app.processIdentifier)
            report("\(route.name.padding(toLength: 34, withPad: " ", startingAt: 0)) \(detail)")
            if let element, winner == nil { winner = (route.name, element) }
        }

        report("")
        guard let winner else {
            report("No route reached a focused element, so this run says nothing about the app.")
            if !AXIsProcessTrusted() {
                // The `kAXErrorAPIDisabled` above is the signature. Said out
                // loud because somebody diagnosing a missing dictation would
                // otherwise read this as a finding about the target app, and
                // the grant belongs to the *launching terminal*, not to this
                // binary (phase-2-report.md §4 HT-1, assumption 10.5).
                report("")
                report("Accessibility is not granted to whatever launched this. Grant it in System")
                report("Settings → Privacy & Security → Accessibility — to the terminal app, not to")
                report("the helper binary — and run this again.")
            } else {
                report("Every route failed with the process trusted, which is evidence about our")
                report("call rather than about the app. That is how phase-2-report.md §3.1 was found.")
            }
            exit(1)
        }

        let element = winner.element
        report("First working route: \(winner.name)")
        report("  role:                 \(copyStringAttribute(element, kAXRoleAttribute as CFString))")
        report("  subrole:              \(copyStringAttribute(element, kAXSubroleAttribute as CFString))")

        var settable: DarwinBoolean = false
        let settableError = AXUIElementIsAttributeSettable(
            element,
            kAXSelectedTextAttribute as CFString,
            &settable
        )
        report("  kAXSelectedText settable: \(settable.boolValue) (\(describe(settableError)))")

        let gateWouldWrite = AXSelectedTextGate.shouldAttemptWrite(
            settableCheckSucceeded: settableError == .success,
            isSettable: settable.boolValue
        )
        report("  the settable gate would:  \(gateWouldWrite ? "attempt the write" : "DECLINE")")

        // Read anyway when the gate would decline. The probe's job is to show
        // what the application does, and a terminal — settable false, write
        // returning success — is precisely the case where the ladder's decision
        // and the application's behaviour have to be visible side by side.
        report("")
        let before = timed { copySelectedRange(of: element) }
        report("  selected range before:    \(describeRange(before.value)) [\(before.elapsed)]")
        report("  characters before:        \(numberOfCharacters(of: element))")
        report("  kAXValue length before:   \(valueLength(of: element))")

        let marker = "GD-AX-OK"
        report("")
        report("  writing \"\(marker)\" — \(marker.utf16.count) UTF-16 units")
        let set = timed {
            AXUIElementSetAttributeValue(
                element,
                kAXSelectedTextAttribute as CFString,
                marker as CFTypeRef
            )
        }
        report("  set kAXSelectedText:      \(describe(set.value)) [\(set.elapsed)]")

        report("")
        let after = timed { copySelectedRange(of: element) }
        report("  selected range after:     \(describeRange(after.value)) [\(after.elapsed)]")
        report("  characters after:         \(numberOfCharacters(of: element))")
        report("  kAXValue length after:    \(valueLength(of: element))")

        let verdict = AXWriteVerification.verdict(
            before: before.value.range,
            after: after.value.range,
            insertedUTF16Count: marker.utf16.count
        )
        let trusted = AXWriteVerification.trustsWrite(verdict)

        report("")
        switch verdict {
        case let .landed(advance):
            report("VERDICT: LANDED — the caret advanced by \(advance).")
        case let .didNotLand(evidence):
            report("VERDICT: DID NOT LAND — \(evidence).")
            report("This application lies about AX writes. Dictation into it must not use the AX tier.")
        case let .unverifiable(evidence):
            report("VERDICT: CANNOT VERIFY — \(evidence).")
        }

        report("")
        if !gateWouldWrite {
            report("The insertion ladder would DECLINE at the settable gate, before writing at all,")
            report("and fall through to Unicode injection. The write above happened because this is")
            report("a probe — that is how an application that lies gets caught.")
        } else if trusted {
            report("The insertion ladder would report tier: ax, ok: true — correctly.")
        } else {
            report("The insertion ladder would DECLINE and fall through to Unicode injection.")
            report("Set GROK_DICTATE_AX_VERIFY=0 to see the pre-Phase-5 behaviour: ok: true, no text.")
        }

        if set.value == .success {
            report("")
            report("If \"\(marker)\" appeared at the caret, press ⌘Z in the app to undo it.")
            report("If it did not appear, the write was discarded and the verdict above says so.")
        }
        // 0 only when the AX tier would both run and be believed, so this is
        // usable as a check rather than only as a report.
        exit(gateWouldWrite && trusted ? 0 : 1)
    }

    private struct Timed<Value> {
        let value: Value
        let elapsed: String
    }

    /// Wall-clock cost of one AX round trip, because "two small AX reads" is a
    /// claim about latency and this is the only place it can be measured.
    private static func timed<Value>(_ body: () -> Value) -> Timed<Value> {
        let started = Date()
        let value = body()
        let ms = Date().timeIntervalSince(started) * 1000
        return Timed(value: value, elapsed: String(format: "%.1f ms", ms))
    }

    private static func describeRange(_ read: AXRangeRead) -> String {
        switch read {
        case let .success(range): return "\(range)"
        case let .failure(reason): return "unreadable — \(reason)"
        }
    }

    /// `kAXNumberOfCharacters`, the corroborating signal the insertion path does
    /// not use: it is optional, many fields do not implement it, and its
    /// expected delta needs the selection length anyway (`AXWriteVerification`).
    private static func numberOfCharacters(of element: AXUIElement) -> String {
        var value: CFTypeRef?
        let error = AXUIElementCopyAttributeValue(
            element,
            kAXNumberOfCharactersAttribute as CFString,
            &value
        )
        guard error == .success, let number = value as? Int else {
            return "unreadable — \(describe(error))"
        }
        return "\(number)"
    }

    /// The length of `kAXValue`, never its contents. The insertion path never
    /// reads this at all: it copies the whole document across the process
    /// boundary, which is slow in a large field and is somebody else's text.
    private static func valueLength(of element: AXUIElement) -> String {
        var value: CFTypeRef?
        let error = AXUIElementCopyAttributeValue(element, kAXValueAttribute as CFString, &value)
        guard error == .success, let value else { return "unreadable — \(describe(error))" }
        guard let string = value as? String else { return "not a string" }
        return "\(string.utf16.count) UTF-16 units"
    }

    private struct AXRoute {
        let name: String
        let make: (pid_t) -> (AXUIElement, Float?)

        /// Returns the focused element, plus a one-line description of what
        /// happened, so a failing route is as informative as a working one.
        func focusedElement(pid: pid_t) -> (AXUIElement?, String) {
            let (root, timeout) = make(pid)
            if let timeout { AXUIElementSetMessagingTimeout(root, timeout) }
            var value: CFTypeRef?
            let error = AXUIElementCopyAttributeValue(
                root,
                kAXFocusedUIElementAttribute as CFString,
                &value
            )
            guard error == .success, let value else { return (nil, describe(error)) }
            guard CFGetTypeID(value) == AXUIElementGetTypeID() else {
                return (nil, "returned something that is not an AXUIElement")
            }
            return (unsafeBitCast(value, to: AXUIElement.self), "OK")
        }

        static let all: [AXRoute] = [
            // What AXInserter does today.
            AXRoute(name: "systemWide, 1s timeout") { _ in (AXUIElementCreateSystemWide(), 1.0) },
            // Is the timeout itself the problem?
            AXRoute(name: "systemWide, default timeout") { _ in (AXUIElementCreateSystemWide(), nil) },
            AXRoute(name: "systemWide, 10s timeout") { _ in (AXUIElementCreateSystemWide(), 10.0) },
            // The route most working implementations use: ask the application
            // element rather than the system-wide one.
            AXRoute(name: "application element, default") { pid in
                (AXUIElementCreateApplication(pid), nil)
            },
            AXRoute(name: "application element, 10s timeout") { pid in
                (AXUIElementCreateApplication(pid), 10.0)
            },
        ]
    }

    private static func copyStringAttribute(_ element: AXUIElement, _ attribute: CFString) -> String {
        var value: CFTypeRef?
        guard AXUIElementCopyAttributeValue(element, attribute, &value) == .success,
            let string = value as? String
        else { return "—" }
        return string
    }

    // MARK: - Secure Input vs the AX API

    /// , open since the research session: "Research confirmed it
    /// blocks event taps. Whether `AXUIElementSetAttributeValue` is also
    /// blocked is **unverified**." This measures it.
    ///
    /// The app itself never attempts this — `contracts/state-machine.md` §8 is
    /// explicit that insertion is never attempted while blocked, precisely so
    /// the app does not find out the hard way inside a password field. So the
    /// experiment lives here, run deliberately, by hand.
    static func runSecureAXProbe(settings: Settings, countdownSeconds: Int) -> Never {
        report("Grok Dictate helper \(helperVersion) — Secure Input vs AX probe")
        report("Accessibility trusted: \(isAccessibilityTrusted(prompt: settings.promptForAccessibility))")
        report("")
        report("Focus a password field (System Settings, a login form, `sudo` in Terminal).")
        for remaining in stride(from: countdownSeconds, through: 1, by: -1) {
            report("  probing in \(remaining)…")
            Thread.sleep(forTimeInterval: 1)
        }

        let secure = IsSecureEventInputEnabled()
        let workspace = WorkspaceMonitor { _ in }
        let front = workspace.frontmostApp
        report("")
        report("IsSecureEventInputEnabled(): \(secure)")
        report("Frontmost:                   \(front.name ?? "?") (\(front.bundleId ?? "no bundle id"))")
        if !secure {
            report("")
            report("Secure Input is NOT active, so this run proves nothing about §9.5.")
            report("Make sure the caret is really inside a password field, then run it again.")
        }

        // A marker string rather than the 300-char fixture: if the write does
        // succeed, it lands in whatever field is focused, and that field is a
        // password box.
        let marker = "GROKDICTATE-AX-PROBE"
        let attempt = AXInserter(
            verifyWrites: settings.verifyAXWrites,
            log: { level, message in report("[\(level.rawValue)] \(message)") }
        ).insertSelectedText(marker, into: front)
        report("")
        switch attempt {
        case .confirmed:
            report("AX write: SUCCEEDED — Secure Input does NOT block AX writes.")
            report("The caret moved, so the string \(marker) really is in the focused field. Clear it.")
        case .succeeded:
            // Only reachable with GROK_DICTATE_AX_VERIFY=0, where the answer to
            // §9.5 rests on the AXError alone — which is exactly the weaker
            // evidence Phase 5 stopped trusting.
            report("AX write: reported success, UNVERIFIED — the caret was not read back.")
            report("Re-run without GROK_DICTATE_AX_VERIFY=0 before recording this as an answer.")
        case let .notLanded(reason), let .failed(reason):
            report("AX write: FAILED — \(reason)")
            if settings.verifyAXWrites {
                // Since Phase 5 this tier also declines when it cannot confirm
                // the caret moved, so a bare "FAILED" no longer means "Secure
                // Input blocked it". The reason above distinguishes them —
                // an AXError names §9.5's answer, a verification decline does
                // not — and this says so rather than leaving the re-run of
                // HT-5 to notice.
                report("")
                report("Note: a decline here can also come from write verification rather than from")
                report("Secure Input. The reason above says which. GROK_DICTATE_AX_VERIFY=0 isolates")
                report("the AXError, and --probe-ax reports every input to the decision.")
            }
        }
        exit(0)
    }

    // MARK: -

    private static func stamp() -> String {
        stamp(Int(Date().timeIntervalSince1970 * 1000))
    }

    private static func stamp(_ millis: Int) -> String {
        let date = Date(timeIntervalSince1970: Double(millis) / 1000)
        let formatter = DateFormatter()
        formatter.dateFormat = "HH:mm:ss.SSS"
        return formatter.string(from: date)
    }

    static func report(_ line: String) {
        FileHandle.standardOutput.write(Data((line + "\n").utf8))
    }
}
