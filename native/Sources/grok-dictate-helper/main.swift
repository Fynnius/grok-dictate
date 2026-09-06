/// Entry point.
///
/// With no arguments this is the protocol-mode helper the Electron app spawns:
/// NDJSON in on stdin, NDJSON out on stdout, nothing else on stdout ever
/// (contract §1). Every `--probe-*` argument is a human-test harness; see
/// `Probes.swift`.

import CoreGraphics
import Foundation
import HelperCore

// A closed pipe must not kill the process by signal — the write path detects
// the failure and exits deliberately, which is the difference between "the app
// quit" and "the helper crashed" in the supervisor's log.
signal(SIGPIPE, SIG_IGN)

let arguments = Array(CommandLine.arguments.dropFirst())
let settings = Settings.fromEnvironment()

func stringOption(_ name: String, default fallback: String) -> String {
    guard let index = arguments.firstIndex(of: name), index + 1 < arguments.count else {
        return fallback
    }
    return arguments[index + 1]
}

func intOption(_ name: String, default fallback: Int) -> Int {
    Int(stringOption(name, default: "")) ?? fallback
}

let usage = """
    grok-dictate-helper \(helperVersion)

    The native half of Grok Dictate: it watches the Fn key and puts text into
    other applications. With no arguments it speaks the newline-delimited JSON
    protocol in contracts/helper-protocol.md over stdin and stdout, which is how
    the Electron app runs it.

    MODES
      (no arguments)        protocol mode
      --probe-tap           print hotkey events as they happen
      --probe-insert        inject a known 300-character string after a countdown
      --probe-ax            compare the routes to the focused AX element, then
                            test-write to it and report whether the write really
                            landed — point this at any app that dictation goes
                            missing in
      --probe-secure-ax     attempt an AX write under Secure Input
      --probe-paste         publish a promised pasteboard item, post ⌘V, and
                            report every read receipt with its latency
      --probe-chunk         how many UTF-16 units one keyboard event can carry
      --version             print the version
      --help                this text

    --probe-tap OPTIONS
      --force-disable <seconds>
                            after this long, disable the live tap the way macOS
                            does on a timeout, and report whether the watchdog
                            brings it back (IMPLEMENTATION-PLAN.md §5b)

    --probe-ax OPTIONS
      --delay <seconds>     countdown before probing (default 5)

                            Exits 0 only if the AX tier would run *and* be
                            believed; 1 if the ladder would fall through to
                            Unicode injection, whether because the attribute is
                            not settable or because the write was discarded.

    --probe-paste OPTIONS
      --delay <seconds>     countdown before publishing (default 5)
      --route <pid|hid|none>
                            where to post the ⌘V chord. Defaults to hid, which
                            is what production PasteInserter.chordRoute ships.
                            Confirming paste on pid alone does not confirm the
                            path that shipped. `none` publishes the promise and
                            posts nothing, so the receipt mechanism can be
                            tested on its own with `pbpaste` from another
                            process
      --text <string>       publish this instead of a marker
      --watch <seconds>     how long to wait for receipts (default 6)

                            Exits 0 only if something read the text type after
                            the chord.

    --probe-insert OPTIONS
      --delay <seconds>     countdown before injecting (default 5)
      --tier <auto|ax|unicode>
                            force one rung of the ladder (default auto)
      --text <string>       inject this instead of the built-in fixture
      --out <path>          where to write exactly what was injected
                            (default probe-out/expected.txt)

    ENVIRONMENT
      GROK_DICTATE_MODIFIER_SETTLE_MS wait for held modifiers (default 500)
      GROK_DICTATE_AX_VERIFY          0 = trust an AX write's return code
                                      instead of reading the caret back. On by
                                      default; off is how dictation silently
                                      disappears in Arc.
      GROK_DICTATE_SECURE_INPUT_POLL_MS  (default 1000)
      GROK_DICTATE_TAP_WATCHDOG_MS       (default 5000)
      GROK_DICTATE_HELPER_DRY_RUN     1 = never insert anything
      GROK_DICTATE_HELPER_PROMPT      1 = show the Accessibility prompt
      GROK_DICTATE_HELPER_NO_TAP      1 = do not install the event tap
    """

if arguments.contains("--help") || arguments.contains("-h") {
    Probes.report(usage)
    exit(0)
}

if arguments.contains("--version") {
    Probes.report(helperVersion)
    exit(0)
}

if arguments.contains("--probe-tap") {
    let forceDisable = arguments.contains("--force-disable")
        ? TimeInterval(intOption("--force-disable", default: 3))
        : nil
    Probes.runTapProbe(settings: settings, forceDisableAfter: forceDisable)
}

if arguments.contains("--probe-ax") {
    Probes.runAXRouteProbe(settings: settings, countdownSeconds: intOption("--delay", default: 5))
}

if arguments.contains("--probe-secure-ax") {
    Probes.runSecureAXProbe(settings: settings, countdownSeconds: intOption("--delay", default: 5))
}

if arguments.contains("--probe-chunk") {
    Probes.runChunkProbe()
}

if arguments.contains("--probe-paste") {
    var options = Probes.PasteOptions()
    options.countdownSeconds = intOption("--delay", default: options.countdownSeconds)
    options.route = stringOption("--route", default: options.route)
    options.text = stringOption("--text", default: options.text)
    options.watchSeconds = TimeInterval(intOption("--watch", default: Int(options.watchSeconds)))
    Probes.runPasteProbe(settings: settings, options: options)
}

if arguments.contains("--probe-insert") {
    var options = Probes.InsertOptions()
    options.countdownSeconds = intOption("--delay", default: options.countdownSeconds)
    options.tier = stringOption("--tier", default: options.tier)
    options.text = stringOption("--text", default: options.text)
    options.outputPath = stringOption("--out", default: options.outputPath)
    Probes.runInsertProbe(settings: settings, options: options)
}

if let unexpected = arguments.first {
    // Fail loudly rather than silently starting in protocol mode: a typo in a
    // flag would otherwise look like the helper simply ignoring the request.
    FileHandle.standardError.write(
        Data("grok-dictate-helper: unrecognised argument \"\(unexpected)\"\n\n\(usage)\n".utf8)
    )
    exit(64)  // EX_USAGE
}

// MARK: - Protocol mode

let helper = HelperApp(settings: settings)

/// The app sends `shutdown`, waits briefly, then SIGTERM, then SIGKILL
/// (contract §3). Handling SIGTERM means the tap is removed on the way out
/// instead of being reclaimed by the kernel.
let terminationSources = [SIGTERM, SIGINT].map { signalNumber -> DispatchSourceSignal in
    signal(signalNumber, SIG_IGN)
    let source = DispatchSource.makeSignalSource(signal: signalNumber, queue: .main)
    source.setEventHandler {
        helper.shutdown()
        exit(0)
    }
    source.resume()
    return source
}
_ = terminationSources

helper.start()
CFRunLoopRun()
