/// The helper in protocol mode: NDJSON on stdin/stdout, an event tap, and the
/// insertion ladder. Everything is wired here and nowhere else.
///
/// Threading, stated once because the rest of the code depends on it: this
/// process is single-threaded apart from one serial queue. The main thread runs
/// a `CFRunLoop` that owns the event tap, both timers and every stdout write.
/// Insertion is the sole exception — it is pushed to a background serial queue
/// by `BackgroundInsertion`, because Unicode injection paces itself between
/// chunks and a paced loop on the main thread would stall the tap callback long
/// enough for macOS to disable the tap. Results hop back to
/// main before being emitted, so stdout has exactly one writer and frame order
/// is preserved (contract §1).

import Foundation
import HelperCore

let helperVersion = "0.1.0"

final class HelperApp {
    private let settings: Settings
    private let recognizer = HotkeyRecognizer()
    private let reader = LineReader()

    private var tap: EventTapController?
    private let permissions = ChangeTracker<Permissions>()
    private var secureInput: SecureInputMonitor?
    private var workspace: WorkspaceMonitor?
    private var router: CommandRouter?
    private var insertion: BackgroundInsertion?
    private var stdoutIsBroken = false
    private var isShuttingDown = false

    /// How long `shutdown` waits for an insert that is already running. The
    /// app sends `shutdown`, waits, then SIGTERM, then SIGKILL (contract §3),
    /// so this has to finish comfortably inside that first wait — otherwise the
    /// helper is killed mid-drain and gains nothing.
    private static let shutdownDrainBudget: TimeInterval = 0.8

    init(settings: Settings) {
        self.settings = settings
    }

    // MARK: - Lifecycle

    func start() {
        let workspace = WorkspaceMonitor { [weak self] app in
            // Unsolicited push: no `id` (contract §2).
            self?.emit(.frontmost(bundleId: app.bundleId, name: app.name, id: nil))
        }
        self.workspace = workspace

        let accessibility: AccessibilityInserting
        let unicode: UnicodeInserting
        if settings.dryRun {
            let dryRun = DryRunInserter()
            accessibility = dryRun
            unicode = dryRun
        } else {
            let emitLog: (LogLevel, String) -> Void = { [weak self] level, message in
                self?.emit(.log(level: level, message: message))
            }
            // The AX tier logs for itself, at `warn`, when an application takes
            // a write and discards it (`AXWriteVerification`). The ladder's own
            // log reports every decline at `info`; that one is a diagnosis of
            // the other application and belongs a level up.
            accessibility = AXInserter(verifyWrites: settings.verifyAXWrites, log: emitLog)
            unicode = UnicodeInserter(settings: settings, log: emitLog)
        }

        let ladder = InsertionLadder(
            accessibility: accessibility,
            unicode: unicode,
            frontmost: workspace,
            axSkipBundleIds: settings.axSkipBundleIds,
            log: { [weak self] level, message in
                self?.emit(.log(level: level, message: message))
            }
        )

        let insertion = BackgroundInsertion(ladder: ladder)
        self.insertion = insertion

        router = CommandRouter(
            insertion: insertion,
            pasteboard: SystemPasteboard(),
            frontmost: workspace,
            emit: { [weak self] frame in self?.emit(frame) },
            onHotkeysChanged: { [weak self] configuration in
                self?.recognizer.setConfiguration(configuration)
            }
        )

        // First frame, before anything that might warn (contract §2).
        emit(.ready(version: helperVersion, caps: [.ax, .unicode]))

        if settings.dryRun {
            emit(
                .log(
                    level: .warn,
                    message:
                        "DRY RUN — GROK_DICTATE_HELPER_DRY_RUN is set, so no text will be inserted anywhere"
                )
            )
        }

        if !settings.verifyAXWrites {
            // Said out loud because the symptom of running this way is text
            // that never appears while the pill turns green, and a machine
            // where somebody set this variable months ago and forgot is the
            // hardest version of that to diagnose.
            emit(
                .log(
                    level: .warn,
                    message:
                        "GROK_DICTATE_AX_VERIFY is off — an AX write will be trusted on its return "
                        + "code alone, so an app that discards it silently loses the dictation"
                )
            )
        }

        if !settings.verifyUnicodeWrites {
            // Same reasoning as the line above, for the other half of BUG-1: run
            // this way and a target that drops a long injection is reported as a
            // plain success again, which is the state the incident was in.
            emit(
                .log(
                    level: .warn,
                    message:
                        "GROK_DICTATE_INJECT_VERIFY is off — injected text will be reported as "
                        + "inserted without checking that it arrived, so an app that drops it "
                        + "loses the dictation silently"
                )
            )
        }

        reportPermissions()
        installTap()
        publishPermissionsIfChanged()

        let secureInput = SecureInputMonitor { [weak self] enabled in
            self?.emit(.secureInput(enabled: enabled))
            // Secure Input tears the tap down system-wide (§4.6), so the
            // hotkey's liveness changes with it.
            self?.publishPermissionsIfChanged()
            if enabled {
                self?.emit(
                    .log(
                        level: .warn,
                        message:
                            "Secure Input is active — macOS blocks every third-party event tap "
                            + "while it is, so the hotkey is dead until the app holding it lets go"
                    )
                )
            }
        }
        secureInput.start(pollInterval: settings.secureInputPollInterval)
        self.secureInput = secureInput

        workspace.start(pollInterval: settings.secureInputPollInterval)
        startReadingStdin()
    }

    /// Reported independently of the tap, because it is independent
    /// information: Accessibility gates both the tap *and* the AX insertion
    /// tier, so its absence is worth saying even when the tap was deliberately
    /// skipped.
    private func reportPermissions() {
        if !isAccessibilityTrusted(prompt: settings.promptForAccessibility) {
            emit(
                .log(
                    level: .error,
                    message:
                        "Accessibility permission is missing. Fn will not be detected and text "
                        + "cannot be inserted with the AX tier. Grant it in System Settings → "
                        + "Privacy & Security → Accessibility."
                )
            )
        }
    }

    /// What the app needs to know to tell the truth about the hotkey.
    private struct Permissions: Equatable {
        let accessibility: Bool
        let hotkeyActive: Bool
    }

    /// Emit `permissions` when the answer changes, and **retry the tap when the
    /// grant arrives**.
    ///
    /// Both halves matter and the second is the one that saves a restart. On the
    /// first launch of a packaged build Accessibility is ungranted — a packaged
    /// `.app` is its own TCC identity (docs/phase-2-report.md §4, HT-1) — so the
    /// tap fails, and until Phase 5 the only way out was to grant the permission
    /// and then quit and reopen the app, with nothing on screen saying so.
    /// Polling here means granting it is enough.
    ///
    /// This rides the Secure Input timer rather than adding one: the two
    /// questions are asked at the same rate and answered by the same thread,
    /// and a second timer would be a second thing to get wrong.
    private func publishPermissionsIfChanged() {
        let trusted = isAccessibilityTrusted()

        // A tap that never installed, or that macOS has torn down, when the
        // permission is now in place: try again rather than wait for a restart.
        if trusted, settings.installTap, tap?.isEnabled != true {
            if tap != nil {
                emit(.log(level: .info, message: "retrying the event tap"))
                tap?.uninstall()
                tap = nil
            }
            installTap()
        }

        let current = Permissions(accessibility: trusted, hotkeyActive: tap?.isEnabled == true)
        guard let changed = permissions.observe(current) else { return }
        emit(
            .permissions(accessibility: changed.accessibility, hotkeyActive: changed.hotkeyActive)
        )
    }

    private func installTap() {
        guard settings.installTap else {
            emit(
                .log(
                    level: .warn,
                    message:
                        "GROK_DICTATE_HELPER_NO_TAP is set — the event tap was not installed and "
                        + "no hotkey will be reported"
                )
            )
            return
        }

        let controller = EventTapController(
            recognizer: recognizer,
            log: { [weak self] level, message in
                self?.emit(.log(level: level, message: message))
            },
            onActions: { [weak self] actions, timestampMs in
                for action in actions {
                    self?.emit(.hotkey(action: action, timestampMs: timestampMs))
                }
            }
        )
        do {
            try controller.install(watchdogInterval: settings.tapWatchdogInterval)
            tap = controller
            emit(.log(level: .info, message: "event tap installed"))
        } catch {
            // Deliberately not fatal. The app still needs a helper that can
            // insert text and answer `get_frontmost`; refusing to start would
            // take those down too, and would replace a specific, actionable
            // message with a process that vanishes.
            let detail = (error as? EventTapController.InstallError)?.description ?? "\(error)"
            emit(.log(level: .error, message: "the hotkey is not active — \(detail)"))
        }
    }

    func shutdown() {
        tap?.uninstall()
        secureInput?.stop()
        workspace?.stop()
        FileHandle.standardInput.readabilityHandler = nil
    }

    // MARK: - stdin

    private func startReadingStdin() {
        FileHandle.standardInput.readabilityHandler = { handle in
            let data = handle.availableData
            DispatchQueue.main.async { [weak self] in
                guard let self else { return }
                if data.isEmpty {
                    // The app closed the pipe. Leave by the same door as an
                    // explicit `shutdown`, so an insert that is still running
                    // gets its chance to report — an EOF arriving one line
                    // after an `insert` is the normal shape when the app quits.
                    for line in self.reader.flush() { self.consume(line) }
                    self.beginShutdown()
                    return
                }
                self.ingest(data)
            }
        }
    }

    func ingest(_ data: Data) {
        for line in reader.feed([UInt8](data)) { consume(line) }
    }

    private func consume(_ line: LineReader.Line) {
        switch line {
        case let .undecodable(reason):
            emit(.log(level: .warn, message: "ignoring unreadable line: \(reason)"))
        case let .line(text):
            guard let router else { return }
            for effect in router.handle(line: text) {
                switch effect {
                case .shutdown:
                    emit(.log(level: .info, message: "shutting down"))
                    beginShutdown()
                }
            }
        }
    }

    // MARK: - stdout

    /// The single writer. Contract §1: "The helper must not write anything to
    /// stdout that is not a frame."
    func emit(_ frame: HelperFrame) {
        guard !stdoutIsBroken else { return }
        guard let data = frame.encoded().data(using: .utf8) else { return }
        do {
            try FileHandle.standardOutput.write(contentsOf: data)
        } catch {
            // The app is gone or its pipe is closed. Stop writing — with
            // SIGPIPE ignored this would otherwise repeat on every frame — and
            // leave through the same door as an EOF on stdin.
            stdoutIsBroken = true
            FileHandle.standardError.write(
                Data("grok-dictate-helper: stdout closed, exiting\n".utf8)
            )
            exitCleanly(code: 0)
        }
    }

    private func exitCleanly(code: Int32) -> Never {
        shutdown()
        exit(code)
    }

    /// Contract §3, `shutdown`: "Remove the event tap, flush stdout, exit 0."
    ///
    /// The tap and the timers go first, so no new work can arrive. Then a
    /// bounded wait for an insert that is already running — insertion happens
    /// on a background queue, and exiting immediately would drop its
    /// `insert_result`. Contract §4 is explicit that "requests are never
    /// silently dropped", and while the app *does* synthesise a failure for an
    /// in-flight insert when the helper dies, that turns a successful insertion
    /// into a reported failure and a spurious "not inserted" pill.
    private func beginShutdown() {
        guard !isShuttingDown else { return }
        isShuttingDown = true
        tap?.uninstall()
        secureInput?.stop()
        workspace?.stop()
        FileHandle.standardInput.readabilityHandler = nil
        waitForInsertsToDrain(deadline: Date().addingTimeInterval(Self.shutdownDrainBudget))
    }

    private func waitForInsertsToDrain(deadline: Date) {
        let pending = insertion?.pendingCount ?? 0
        if pending == 0 { exitCleanly(code: 0) }
        if Date() >= deadline {
            emit(
                .log(
                    level: .warn,
                    message: "exiting with \(pending) insert(s) still running; they will be reported as failures"
                )
            )
            exitCleanly(code: 0)
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.02) { [weak self] in
            self?.waitForInsertsToDrain(deadline: deadline)
        }
    }
}

/// Moves the insertion ladder off the main thread. See the note at the top of
/// this file. The queue is **serial** on purpose: two overlapping Unicode
/// injections would interleave their characters, producing text that is not
/// either transcript.
final class BackgroundInsertion: InsertionPerforming {
    private let ladder: InsertionLadder
    private let queue = DispatchQueue(label: "com.grokdictate.helper.insertion", qos: .userInitiated)

    /// Read and written only on the main thread — `perform` is called from the
    /// command router and the completion hops back — so no lock is needed.
    private(set) var pendingCount = 0

    init(ladder: InsertionLadder) {
        self.ladder = ladder
    }

    func perform(
        text: String,
        targetBundleId: String?,
        completion: @escaping (InsertionOutcome) -> Void
    ) {
        pendingCount += 1
        queue.async { [ladder] in
            let outcome = ladder.run(text: text, targetBundleId: targetBundleId)
            DispatchQueue.main.async { [weak self] in
                self?.pendingCount -= 1
                completion(outcome)
            }
        }
    }
}
