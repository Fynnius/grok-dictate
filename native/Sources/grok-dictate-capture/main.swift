/// grok-dictate-capture — native microphone adapter for Grok Dictate.
///
/// This process opens the default input, converts to 16 kHz mono PCM16, and
/// emits 100 ms / 3200-byte chunks. It is *not* the helper: no event tap, no
/// pasteboard, no insertion, no token, no STT. The helper stays hotkey +
/// insertion only.
///
/// Protocol (stdin/stdout JSON lines, UTF-8, one object per line):
///
/// App → capture:
///   {"type":"start","sessionId":"...","sampleRate":16000,"chunkBytes":3200}
///   {"type":"stop","sessionId":"..."}
///   {"type":"cancel","sessionId":"..."}
///
/// Capture → app:
///   {"type":"started","sessionId":"...","actualSampleRate":16000}
///   {"type":"chunk","sessionId":"...","pcm":"<base64 of raw PCM16 LE bytes>"}
///   {"type":"level","sessionId":"...","level":0.0-1.0}
///   {"type":"drained","sessionId":"..."}
///   {"type":"error","sessionId":"...","code":"audio_device"|"audio_permission","message":"...","hint":"..."}
///
/// Unknown stdin lines: log to stderr, do not die.
/// A close of stdin or SIGTERM: stop the device if open, drain, exit 0.
/// The microphone is opened only on `start`, never at process launch.

import Foundation

let captureVersion = "0.1.0"

signal(SIGPIPE, SIG_IGN)

let arguments = Array(CommandLine.arguments.dropFirst())

let usage = """
    grok-dictate-capture \(captureVersion)

    Native microphone capture for Grok Dictate. With no arguments it speaks the
    JSON-lines protocol documented at the top of main.swift over stdin/stdout.
    The device is opened only on start, and capture is raw — no echo
    cancellation, noise suppression, or automatic gain.

    MODES
      (no arguments)        protocol mode
      --version             print the version
      --help                this text

    ENVIRONMENT
      GROK_DICTATE_CAPTURE_DRY_RUN  1 = accept start/stop/cancel without
                                    opening a microphone (used by tests)
    """

if arguments.contains("--help") || arguments.contains("-h") {
    FileHandle.standardOutput.write(Data((usage + "\n").utf8))
    exit(0)
}

if arguments.contains("--version") {
    FileHandle.standardOutput.write(Data((captureVersion + "\n").utf8))
    exit(0)
}

if let unexpected = arguments.first {
    FileHandle.standardError.write(
        Data("grok-dictate-capture: unrecognised argument \"\(unexpected)\"\n\n\(usage)\n".utf8)
    )
    exit(64)  // EX_USAGE
}

let dryRun = {
    let value = ProcessInfo.processInfo.environment["GROK_DICTATE_CAPTURE_DRY_RUN"] ?? ""
    return value == "1" || value.lowercased() == "true"
}()

let app = CaptureApp(dryRun: dryRun)

let terminationSources = [SIGTERM, SIGINT].map { signalNumber -> DispatchSourceSignal in
    signal(signalNumber, SIG_IGN)
    let source = DispatchSource.makeSignalSource(signal: signalNumber, queue: .main)
    source.setEventHandler {
        app.shutdown(drain: true)
        exit(0)
    }
    source.resume()
    return source
}
_ = terminationSources

app.startReadingStdin()
CFRunLoopRun()
