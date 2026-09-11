/// AVAudioEngine capture. The device is opened in `start` and released in
/// `stop`. There is no voice-processing IO, no echo canceller, no AGC — a raw
/// tap on the HAL input, converted to 16 kHz mono PCM16.

import AVFoundation
import CaptureCore
import Foundation

final class CaptureEngine {
    struct OpenError: Error {
        let code: CaptureErrorCode
        let message: String
        let hint: String
    }

    private var engine: AVAudioEngine?
    private var converter: AVAudioConverter?
    private var chunker = PcmChunker(chunkBytes: 3200)
    private var tapInstalled = false
    private var onChunks: (([PcmChunk]) -> Void)?
    private let lock = NSLock()

    func start(
        sampleRate: Double,
        chunkBytes: Int,
        onChunks: @escaping ([PcmChunk]) -> Void
    ) throws {
        _ = stop(dropTail: true)
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
        // Without prepare(), `inputFormat(forBus:)` is often 0 Hz on a
        // command-line process that has never run an engine.
        engine.prepare()
        let input = engine.inputNode
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
        // Default quality is fine; do not attach a voice-processing graph.
        self.converter = converter
        self.engine = engine
        input.installTap(onBus: 0, bufferSize: 4096, format: hardwareFormat) { [weak self] buffer, _ in
            self?.handleTap(buffer)
        }
        tapInstalled = true

        do {
            try engine.start()
        } catch {
            input.removeTap(onBus: 0)
            tapInstalled = false
            self.engine = nil
            self.converter = nil
            throw OpenError(
                code: .audioDevice,
                message: "Could not start the microphone.",
                hint: "Check System Settings → Privacy & Security → Microphone and switch Grok Dictate on."
            )
        }
    }

    func stop(dropTail: Bool) -> PcmChunk? {
        lock.lock()
        let engine = self.engine
        let tapInstalled = self.tapInstalled
        self.engine = nil
        self.converter = nil
        self.tapInstalled = false
        self.onChunks = nil
        let tail: PcmChunk?
        if dropTail {
            chunker.reset()
            tail = nil
        } else {
            tail = chunker.flush()
        }
        lock.unlock()

        if let engine {
            if tapInstalled {
                engine.inputNode.removeTap(onBus: 0)
            }
            if engine.isRunning {
                engine.stop()
            }
        }
        return tail
    }

    private func handleTap(_ buffer: AVAudioPCMBuffer) {
        // Convert, chunk and deliver while holding the lock. `stop` takes the
        // same lock, so a drain cannot be emitted until this tap has written
        // its chunks. The buffer is only valid inside the tap callback.
        lock.lock()
        defer { lock.unlock() }
        guard let converter else { return }
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
