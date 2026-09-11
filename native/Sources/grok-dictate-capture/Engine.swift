/// AVAudioEngine capture. Prepare and start are different operations.
///
/// Every hold used to construct a new engine, `prepare()`, install a tap and
/// `start()` it, then `stop()` which **releases the prepare() allocations**
/// (Apple's own note on `stop()`). That is a cold HAL open on every Fn press,
/// typically a few hundred milliseconds, and speech during it is never a
/// sample — the first word of a hold, every time. Connect-time buffering
/// cannot rescue audio from a device that is not open yet.
///
/// The graph is now built and `prepare()`d while idle (process launch, and
/// again after a device change). `start` only installs the tap and starts
/// hardware. `stop` **pauses** rather than `stop()`s so those allocations
/// survive; `pause()` stops the audio hardware (orange indicator off) and
/// does not deallocate `prepare()`. Process exit is the one path that
/// `stop()`s, via `dispose()`.
///
/// Idea from FluidVoice's prepare/start split; reimplemented against
/// AVAudioEngine. No source copied.
///
/// There is no voice-processing IO, no echo canceller, no AGC — a raw tap
/// on the HAL input, converted to 16 kHz mono PCM16.
///
/// **Orange indicator.** `prepare()` must not light it; `start()` must; `pause()`
/// must turn it off. If a real Mac ever shows orange while idle, `pause()`
/// is the first thing to look at — fall back to `stop()` + `prepare()` on
/// the session-end path rather than leaving the indicator on.

import AVFoundation
import CaptureCore
import CaptureObjC
import Foundation

final class CaptureEngine {
    struct OpenError: Error {
        let code: CaptureErrorCode
        let message: String
        let hint: String
    }

    /// 512 frames. **Chosen, not measured.** The previous 4096 at 48 kHz is
    /// ~85 ms before the first tap callback; 512 is ~11 ms. The callback still
    /// contains those frames, so this is delivery latency for the HUD level
    /// and `first_pcm_main`, not clipping — clipping is the device not being
    /// open. Apple treats the value as a hint.
    private static let tapBufferFrames: AVAudioFrameCount = 512

    private var engine: AVAudioEngine?
    private var converter: AVAudioConverter?
    private var outputFormat: AVAudioFormat?
    private var hardwareFormat: AVAudioFormat?
    private var chunker = PcmChunker(chunkBytes: 3200)
    private var tapInstalled = false
    /// Our own latch. After `pause()`, `engine.isRunning` can stay true, so
    /// it is not a safe stand-in for "hardware is capturing".
    private var ioRunning = false
    private var onChunks: (([PcmChunk]) -> Void)?
    private let lock = NSLock()
    private var configObserver: NSObjectProtocol?
    private var handlingConfigChange = false

    /// Build and `prepare()` the graph without starting IO.
    ///
    /// Safe at process launch: `prepare()` does not start hardware. Skipped
    /// when microphone permission is not yet granted, so a first-run TCC
    /// prompt still happens at the first press rather than at launch. Failures
    /// are swallowed; `start` retries and is what reports to the user.
    func prepareIdle(sampleRate: Double) {
        switch AVCaptureDevice.authorizationStatus(for: .audio) {
        case .authorized:
            break
        default:
            return
        }
        do {
            _ = try ensureGraph(sampleRate: sampleRate)
        } catch let error as OpenError {
            logStderr("idle prepare skipped: \(error.message)")
        } catch {
            logStderr("idle prepare skipped")
        }
    }

    func start(
        sampleRate: Double,
        chunkBytes: Int,
        onChunks: @escaping ([PcmChunk]) -> Void
    ) throws {
        let t0 = CFAbsoluteTimeGetCurrent()
        _ = releaseSession(dropTail: true)
        self.onChunks = onChunks
        chunker = PcmChunker(chunkBytes: chunkBytes)

        switch AVCaptureDevice.authorizationStatus(for: .audio) {
        case .denied, .restricted:
            throw OpenError(
                code: .audioPermission,
                message: "Grok Dictate is not allowed to use the microphone.",
                hint: "Open System Settings → Privacy & Security → Microphone and switch Grok Dictate on, then try again."
            )
        default:
            break
        }

        let reused = try ensureGraph(sampleRate: sampleRate)
        guard let engine else {
            throw OpenError(
                code: .audioDevice,
                message: "Could not build a 16 kHz mono PCM16 stream.",
                hint: "Try dictating again. If it keeps happening, rebuild the capture binary with `./native/build.sh`."
            )
        }

        if !tapInstalled {
            try installTap(on: engine)
        }

        do {
            try engine.start()
            ioRunning = true
        } catch {
            removeTap(from: engine)
            throw OpenError(
                code: .audioDevice,
                message: "Could not start the microphone.",
                hint: "Check System Settings → Privacy & Security → Microphone and switch Grok Dictate on."
            )
        }

        let ms = Int(((CFAbsoluteTimeGetCurrent() - t0) * 1000).rounded())
        logStderr("engine start \(ms) ms (\(reused ? "warm" : "cold"))")
    }

    func stop(dropTail: Bool) -> PcmChunk? {
        releaseSession(dropTail: dropTail)
    }

    /// Full release. Process exit only — this is the one `engine.stop()` that
    /// is allowed to throw away `prepare()`.
    func dispose() {
        _ = releaseSession(dropTail: true)
        if let observer = configObserver {
            NotificationCenter.default.removeObserver(observer)
            configObserver = nil
        }
        if let engine {
            engine.stop()
        }
        self.engine = nil
        self.converter = nil
        self.outputFormat = nil
        self.hardwareFormat = nil
        self.ioRunning = false
        self.tapInstalled = false
    }

    /// End a live session without tearing the graph down.
    ///
    /// Removes the tap so session N cannot leak into N+1, `pause()`s so the
    /// orange indicator goes off and `prepare()` survives, resets the
    /// converter so codec state does not carry across holds.
    private func releaseSession(dropTail: Bool) -> PcmChunk? {
        lock.lock()
        let engine = self.engine
        let hadTap = self.tapInstalled
        self.onChunks = nil
        converter?.reset()
        let tail: PcmChunk?
        if dropTail {
            chunker.reset()
            tail = nil
        } else {
            tail = chunker.flush()
        }
        lock.unlock()

        if let engine {
            if hadTap {
                removeTap(from: engine)
            }
            if ioRunning {
                engine.pause()
                ioRunning = false
            }
        }
        return tail
    }

    /// - Returns: `true` when the existing prepared graph was reused.
    @discardableResult
    private func ensureGraph(sampleRate: Double) throws -> Bool {
        if let existing = engine,
            converter != nil,
            outputFormat?.sampleRate == sampleRate,
            hardwareFormatStillValid(existing)
        {
            // Already prepared and paused. `start()` will resume IO.
            // Calling `prepare()` again is unnecessary and, on a graph that
            // has not yet created its nodes, aborts the process (NSException
            // `inputNode != nullptr || outputNode != nullptr`).
            return true
        }

        rebuildGraph()
        try finishRebuild(sampleRate: sampleRate)
        return false
    }

    private func rebuildGraph() {
        if let observer = configObserver {
            NotificationCenter.default.removeObserver(observer)
            configObserver = nil
        }
        if let engine {
            if tapInstalled {
                removeTap(from: engine)
            }
            if ioRunning || engine.isRunning {
                engine.stop()
            }
        }
        self.engine = nil
        self.converter = nil
        self.outputFormat = nil
        self.hardwareFormat = nil
        self.ioRunning = false
    }

    private func finishRebuild(sampleRate: Double) throws {
        // Non-interleaved: `int16ChannelData` is nil for an interleaved
        // format, and we would emit empty chunks while the tap still ran.
        // Mono is the same layout either way.
        guard
            let outputFormat = AVAudioFormat(
                commonFormat: .pcmFormatInt16,
                sampleRate: sampleRate,
                channels: 1,
                interleaved: false
            )
        else {
            throw OpenError(
                code: .audioDevice,
                message: "Could not build a 16 kHz mono PCM16 stream.",
                hint: "Try dictating again. If it keeps happening, rebuild the capture binary with `./native/build.sh`."
            )
        }

        let engine = AVAudioEngine()
        // Accessing `inputNode` is what creates it. `prepare()` before that
        // raises NSException `inputNode != nullptr || outputNode != nullptr`
        // and aborts the process — Swift `catch` does not see it. The 2026-09-11
        // crash reports were exactly this, at first Fn press.
        let input = engine.inputNode
        try objcAudio("prepare") { engine.prepare() }
        let hardwareFormat = input.inputFormat(forBus: 0)
        if hardwareFormat.sampleRate <= 0 || hardwareFormat.channelCount == 0 {
            throw OpenError(
                code: .audioDevice,
                message: "No microphone is available.",
                hint: "Plug in or enable an input device and try again."
            )
        }

        guard let converter = AVAudioConverter(from: hardwareFormat, to: outputFormat) else {
            throw OpenError(
                code: .audioDevice,
                message: "Could not convert the microphone to 16 kHz mono PCM16.",
                hint: "The input device's format is not usable. Try a different microphone."
            )
        }

        self.outputFormat = outputFormat
        self.hardwareFormat = hardwareFormat
        self.converter = converter
        self.engine = engine
        observe(engine)
    }

    private func hardwareFormatStillValid(_ engine: AVAudioEngine) -> Bool {
        let current = engine.inputNode.inputFormat(forBus: 0)
        guard let cached = hardwareFormat else { return false }
        return current.sampleRate > 0
            && current.channelCount > 0
            && current.sampleRate == cached.sampleRate
            && current.channelCount == cached.channelCount
    }

    private func installTap(on engine: AVAudioEngine) throws {
        let input = engine.inputNode
        let format = input.inputFormat(forBus: 0)
        try objcAudio("installTap") {
            input.installTap(onBus: 0, bufferSize: Self.tapBufferFrames, format: format) {
                [weak self] buffer, _ in
                self?.handleTap(buffer)
            }
        }
        tapInstalled = true
    }

    private func removeTap(from engine: AVAudioEngine) {
        guard tapInstalled else { return }
        // `removeTap` with no tap is an NSException, not an error. A device
        // change can invalidate the tap under us.
        _ = GDCatchException { engine.inputNode.removeTap(onBus: 0) }
        tapInstalled = false
    }

    /// AVAudioEngine raises `NSException` for illegal graph states. Those
    /// abort the process unless caught here; the user then sees "capture
    /// process stopped unexpectedly" instead of a recoverable device error.
    private func objcAudio(_ label: String, _ body: () -> Void) throws {
        if let exception = GDCatchException(body) {
            logStderr("\(label) raised \(exception.name.rawValue): \(exception.reason ?? "")")
            throw OpenError(
                code: .audioDevice,
                message: "Could not start the microphone.",
                hint: "Try dictating again. If it keeps happening, rebuild the capture binary with `./native/build.sh`."
            )
        }
    }

    private func observe(_ engine: AVAudioEngine) {
        if let observer = configObserver {
            NotificationCenter.default.removeObserver(observer)
        }
        configObserver = NotificationCenter.default.addObserver(
            forName: .AVAudioEngineConfigurationChange,
            object: engine,
            queue: OperationQueue.main
        ) { [weak self] _ in
            self?.handleConfigurationChange()
        }
    }

    /// The system has paused the engine (default input changed, AirPods, etc.).
    /// Rebuild the converter against the new hardware format. A live session
    /// is restarted so a mid-hold device switch does not sit in silence until
    /// the no-speech watchdog.
    private func handleConfigurationChange() {
        guard !handlingConfigChange else { return }
        handlingConfigChange = true
        defer { handlingConfigChange = false }

        lock.lock()
        let live = onChunks
        let sampleRate = outputFormat?.sampleRate ?? 16_000
        let chunkBytes = chunker.chunkBytes
        lock.unlock()

        if let engine, tapInstalled {
            removeTap(from: engine)
        }
        ioRunning = false
        converter = nil
        hardwareFormat = nil

        if let live {
            do {
                try start(sampleRate: sampleRate, chunkBytes: chunkBytes, onChunks: live)
                logStderr("engine restarted after a device change")
            } catch let error as OpenError {
                logStderr("engine could not restart after a device change: \(error.message)")
            } catch {
                logStderr("engine could not restart after a device change")
            }
        } else {
            prepareIdle(sampleRate: sampleRate)
        }
    }

    private func handleTap(_ buffer: AVAudioPCMBuffer) {
        // Convert, chunk and deliver while holding the lock. `releaseSession`
        // takes the same lock, so a drain cannot be emitted until this tap
        // has written its chunks. The buffer is only valid inside the tap
        // callback.
        lock.lock()
        defer { lock.unlock() }
        guard onChunks != nil, let converter else { return }
        guard let converted = convert(buffer, with: converter) else { return }
        let chunks = chunker.push(converted)
        if !chunks.isEmpty {
            onChunks?(chunks)
        }
    }

    private func convert(_ buffer: AVAudioPCMBuffer, with converter: AVAudioConverter) -> Data? {
        let outputFormat = converter.outputFormat
        let ratio = outputFormat.sampleRate / buffer.format.sampleRate
        let capacity = AVAudioFrameCount((Double(buffer.frameLength) * ratio).rounded(.up) + 32)
        guard
            let output = AVAudioPCMBuffer(pcmFormat: outputFormat, frameCapacity: max(capacity, 1))
        else {
            return nil
        }

        var consumed = false
        var error: NSError?
        let status = converter.convert(to: output, error: &error) { _, status in
            if consumed {
                status.pointee = .noDataNow
                return nil
            }
            consumed = true
            status.pointee = .haveData
            return buffer
        }
        if status == .error { return nil }
        return int16Bytes(output)
    }
}

private func int16Bytes(_ buffer: AVAudioPCMBuffer) -> Data {
    let frames = Int(buffer.frameLength)
    if frames == 0 { return Data() }
    let channels = Int(buffer.format.channelCount)
    let sampleCount = frames * max(channels, 1)
    guard let pointer = buffer.int16ChannelData?[0] else { return Data() }
    return Data(bytes: pointer, count: sampleCount * MemoryLayout<Int16>.size)
}
