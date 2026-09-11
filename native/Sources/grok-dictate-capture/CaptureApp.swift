import CaptureCore
import Foundation
import HelperCore

final class CaptureApp {
    private let dryRun: Bool
    private let reader = LineReader()
    private let engine = CaptureEngine()
    private var stdoutIsBroken = false
    private var isShuttingDown = false
    private var sessionId: String?

    init(dryRun: Bool) {
        self.dryRun = dryRun
    }

    func startReadingStdin() {
        if dryRun {
            logStderr("DRY RUN — GROK_DICTATE_CAPTURE_DRY_RUN is set, so the microphone will not open")
        }
        // After the run loop is spinning — `prepare()` before that has no
        // audio session and can raise. Does not open the device.
        if !dryRun {
            DispatchQueue.main.async { [weak self] in
                self?.engine.prepareIdle(sampleRate: 16_000)
            }
        }
        FileHandle.standardInput.readabilityHandler = { [weak self] handle in
            let data = handle.availableData
            DispatchQueue.main.async {
                guard let self else { return }
                if data.isEmpty {
                    for line in self.reader.flush() { self.consume(line) }
                    self.shutdown(drain: true)
                    exit(0)
                }
                self.ingest(data)
            }
        }
    }

    func ingest(_ data: Data) {
        for line in reader.feed([UInt8](data)) { consume(line) }
    }

    func shutdown(drain: Bool) {
        guard !isShuttingDown else { return }
        isShuttingDown = true
        FileHandle.standardInput.readabilityHandler = nil
        if drain {
            finishStop(dropTail: false)
        } else {
            finishStop(dropTail: true)
        }
        engine.dispose()
    }

    private func consume(_ line: LineReader.Line) {
        switch line {
        case let .undecodable(reason):
            logStderr("ignoring unreadable line: \(reason)")
        case let .line(text):
            switch CaptureCommandDecoder.decode(line: text) {
            case let .command(command):
                handle(command)
            case let .unknownType(type):
                logStderr("ignoring unknown type \"\(type)\"")
            case let .malformed(reason):
                logStderr("ignoring malformed line: \(reason)")
            }
        }
    }

    private func handle(_ command: CaptureCommand) {
        switch command {
        case let .start(sessionId, sampleRate, chunkBytes):
            handleStart(sessionId: sessionId, sampleRate: sampleRate, chunkBytes: chunkBytes)
        case let .stop(sessionId):
            handleStop(sessionId: sessionId, dropTail: false)
        case let .cancel(sessionId):
            handleStop(sessionId: sessionId, dropTail: true)
        }
    }

    private func handleStart(sessionId: String, sampleRate: Int, chunkBytes: Int) {
        // A new start after stop (or a press that supersedes a press) must
        // take the device immediately. Drain the previous session first so
        // its tail is not mixed into the new one.
        if self.sessionId != nil {
            finishStop(dropTail: false)
        }
        self.sessionId = sessionId

        if dryRun {
            emit(.started(sessionId: sessionId, actualSampleRate: sampleRate))
            return
        }

        do {
            try engine.start(sampleRate: Double(sampleRate), chunkBytes: chunkBytes) {
                [weak self] chunks in
                // Synchronous on the tap thread, while the engine still holds
                // its lock: `stop` waits on that lock, so drained cannot overtake
                // in-flight chunks.
                guard let self, self.sessionId == sessionId else { return }
                for chunk in chunks {
                    self.emit(.chunk(sessionId: sessionId, pcm: chunk.pcm))
                    self.emit(.level(sessionId: sessionId, level: chunk.level))
                }
            }
            emit(.started(sessionId: sessionId, actualSampleRate: sampleRate))
        } catch let error as CaptureEngine.OpenError {
            self.sessionId = nil
            emit(
                .error(
                    sessionId: sessionId,
                    code: error.code,
                    message: error.message,
                    hint: error.hint
                )
            )
        } catch {
            self.sessionId = nil
            emit(
                .error(
                    sessionId: sessionId,
                    code: .audioDevice,
                    message: "Could not open the microphone.",
                    hint: "Check that an input device is connected and try again."
                )
            )
        }
    }

    private func handleStop(sessionId: String, dropTail: Bool) {
        if self.sessionId != sessionId {
            // Late stop for a superseded session: ignore. The live session
            // owns the device.
            return
        }
        finishStop(dropTail: dropTail)
    }

    private func finishStop(dropTail: Bool) {
        let sessionId = self.sessionId
        let tail = engine.stop(dropTail: dropTail)
        self.sessionId = nil
        guard let sessionId else { return }
        if let tail {
            emit(.chunk(sessionId: sessionId, pcm: tail.pcm))
            emit(.level(sessionId: sessionId, level: tail.level))
        }
        emit(.drained(sessionId: sessionId))
    }

    private func emit(_ frame: CaptureFrame) {
        guard !stdoutIsBroken else { return }
        guard let data = frame.encoded().data(using: .utf8) else { return }
        do {
            try FileHandle.standardOutput.write(contentsOf: data)
        } catch {
            stdoutIsBroken = true
            logStderr("stdout closed, exiting")
            _ = engine.stop(dropTail: true)
            exit(0)
        }
    }
}

func logStderr(_ message: String) {
    FileHandle.standardError.write(Data("grok-dictate-capture: \(message)\n".utf8))
}
