/// Wire protocol for `grok-dictate-capture`.
///
/// One UTF-8 JSON object per line. There is no `v` field — this process is not
/// the helper and must not speak `contracts/helper-protocol.ts`. Decoding never
/// throws: a malformed or unknown line is a value the caller logs to stderr.

import Foundation

// MARK: - App → capture

public enum CaptureCommand: Sendable, Equatable {
    case start(sessionId: String, sampleRate: Int, chunkBytes: Int)
    case stop(sessionId: String)
    case cancel(sessionId: String)
}

public enum DecodedCaptureCommand: Sendable, Equatable {
    case command(CaptureCommand)
    case unknownType(String)
    case malformed(reason: String)
}

public enum CaptureCommandDecoder {
    public static func decode(line: String) -> DecodedCaptureCommand {
        let trimmed = line.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.isEmpty { return .malformed(reason: "empty line") }

        guard let data = trimmed.data(using: .utf8) else {
            return .malformed(reason: "line is not valid UTF-8")
        }
        guard let parsed = try? JSONSerialization.jsonObject(with: data, options: []) else {
            return .malformed(reason: "not JSON")
        }
        guard let object = parsed as? [String: Any] else {
            return .malformed(reason: "top-level value is not a JSON object")
        }
        guard let type = object["type"] as? String else {
            return .malformed(reason: "missing or non-string \"type\"")
        }

        switch type {
        case "start":
            guard let sessionId = object["sessionId"] as? String, !sessionId.isEmpty else {
                return .malformed(reason: "start is missing sessionId")
            }
            guard let sampleRate = intValue(object["sampleRate"]), sampleRate > 0 else {
                return .malformed(reason: "start is missing a positive sampleRate")
            }
            guard let chunkBytes = intValue(object["chunkBytes"]), chunkBytes > 0, chunkBytes % 2 == 0
            else {
                return .malformed(reason: "start is missing a positive even chunkBytes")
            }
            return .command(.start(sessionId: sessionId, sampleRate: sampleRate, chunkBytes: chunkBytes))
        case "stop":
            guard let sessionId = object["sessionId"] as? String, !sessionId.isEmpty else {
                return .malformed(reason: "stop is missing sessionId")
            }
            return .command(.stop(sessionId: sessionId))
        case "cancel":
            guard let sessionId = object["sessionId"] as? String, !sessionId.isEmpty else {
                return .malformed(reason: "cancel is missing sessionId")
            }
            return .command(.cancel(sessionId: sessionId))
        default:
            return .unknownType(type)
        }
    }
}

// MARK: - Capture → app

public enum CaptureErrorCode: String, Sendable {
    case audioDevice = "audio_device"
    case audioPermission = "audio_permission"
}

/// The input device `start()` actually opened, read from CoreAudio once the
/// hardware is up. Diagnostic only — every field is independently optional
/// because a property read can fail without the capture itself having
/// failed, and the main process must still be able to correlate a slow
/// `first_pcm_main` with *something* even when only one field came back.
///
/// Deliberately has no `name` or `uid`: `main.log` gets pasted into public
/// GitHub issues, a Bluetooth device's UID embeds its MAC address, and a
/// device name is often personal ("Fynn's AirPods"). `transport` +
/// `sampleRateHz` fully answer the question this exists for (was a slow
/// `first_pcm_main` a Bluetooth HFP switch?) without carrying that risk.
///
/// `transport` is a pre-bucketed string (`"built_in"`, `"bluetooth"`,
/// `"bluetooth_le"`, `"usb"`, `"aggregate"`, `"virtual"`, or `"unknown"` for
/// anything CoreAudio reports outside that list) rather than the raw
/// `kAudioDevicePropertyTransportType` code, so this module stays free of
/// CoreAudio (see Package.swift) and the TypeScript side never has to know
/// the FourCharCode values.
public struct CaptureDeviceInfo: Sendable, Equatable {
    public let transport: String?
    public let sampleRateHz: Double?

    public init(transport: String?, sampleRateHz: Double?) {
        self.transport = transport
        self.sampleRateHz = sampleRateHz
    }
}

/// Bucketing for `kAudioDevicePropertyTransportType`, pulled out as a pure
/// function (raw `UInt32` in, `String` out) so `CaptureCoreTests` can cover
/// every case without linking CoreAudio. The raw values below are the
/// `kAudioDeviceTransportType*` FourCharCodes from `CoreAudio/AudioHardwareBase.h`,
/// restated as integers rather than imported.
public enum CaptureDeviceTransportBucket {
    public static func bucket(rawTransportType: UInt32) -> String {
        switch rawTransportType {
        case 1_651_274_862: return "built_in"  // 'bltn'
        case 1_651_275_109: return "bluetooth"  // 'blue'
        case 1_651_271_009: return "bluetooth_le"  // 'blea'
        case 1_970_496_032: return "usb"  // 'usb '
        case 1_735_554_416: return "aggregate"  // 'grup'
        case 1_986_622_068: return "virtual"  // 'virt'
        default: return "unknown"
        }
    }
}

public enum CaptureFrame: Sendable, Equatable {
    case started(sessionId: String, actualSampleRate: Int, device: CaptureDeviceInfo? = nil)
    case chunk(sessionId: String, pcm: Data)
    case level(sessionId: String, level: Double)
    case drained(sessionId: String)
    case error(sessionId: String, code: CaptureErrorCode, message: String, hint: String)

    /// One NDJSON line, newline included. `type` leads so a log is readable by eye.
    public func encoded() -> String {
        var fields: [(String, String)] = []
        switch self {
        case let .started(sessionId, actualSampleRate, device):
            fields.append(("type", Self.json("started")))
            fields.append(("sessionId", Self.json(sessionId)))
            fields.append(("actualSampleRate", String(actualSampleRate)))
            if let device, let encodedDevice = Self.jsonDevice(device) {
                fields.append(("device", encodedDevice))
            }
        case let .chunk(sessionId, pcm):
            fields.append(("type", Self.json("chunk")))
            fields.append(("sessionId", Self.json(sessionId)))
            fields.append(("pcm", Self.json(pcm.base64EncodedString())))
        case let .level(sessionId, level):
            fields.append(("type", Self.json("level")))
            fields.append(("sessionId", Self.json(sessionId)))
            fields.append(("level", Self.jsonNumber(level)))
        case let .drained(sessionId):
            fields.append(("type", Self.json("drained")))
            fields.append(("sessionId", Self.json(sessionId)))
        case let .error(sessionId, code, message, hint):
            fields.append(("type", Self.json("error")))
            fields.append(("sessionId", Self.json(sessionId)))
            fields.append(("code", Self.json(code.rawValue)))
            fields.append(("message", Self.json(message)))
            fields.append(("hint", Self.json(hint)))
        }
        let body = fields.map { "\(Self.json($0.0)):\($0.1)" }.joined(separator: ",")
        return "{\(body)}\n"
    }

    private static func json(_ value: String) -> String {
        guard
            let data = try? JSONSerialization.data(
                withJSONObject: value,
                options: [.fragmentsAllowed]
            ),
            let literal = String(data: data, encoding: .utf8)
        else {
            return "\"\""
        }
        return literal
    }

    private static func jsonNumber(_ value: Double) -> String {
        let clamped: Double
        if value.isNaN || value.isInfinite {
            clamped = 0
        } else {
            clamped = min(1, max(0, value))
        }
        guard
            let data = try? JSONSerialization.data(
                withJSONObject: clamped,
                options: [.fragmentsAllowed]
            ),
            let literal = String(data: data, encoding: .utf8)
        else {
            return "0"
        }
        return literal
    }

    /// Unclamped, unlike `jsonNumber` (built for the 0...1 level). A
    /// non-finite rate should not happen — callers already guard it — but a
    /// bad read must still produce valid JSON rather than corrupt the line.
    private static func jsonRawNumber(_ value: Double) -> String {
        guard value.isFinite else { return "0" }
        guard
            let data = try? JSONSerialization.data(
                withJSONObject: value,
                options: [.fragmentsAllowed]
            ),
            let literal = String(data: data, encoding: .utf8)
        else {
            return "0"
        }
        return literal
    }

    /// `nil` when every field of `device` is `nil`, so a device that
    /// CoreAudio could not describe at all does not add an empty `{}` to the
    /// line.
    private static func jsonDevice(_ device: CaptureDeviceInfo) -> String? {
        var fields: [(String, String)] = []
        if let transport = device.transport { fields.append(("transport", json(transport))) }
        if let sampleRateHz = device.sampleRateHz {
            fields.append(("sampleRateHz", jsonRawNumber(sampleRateHz)))
        }
        guard !fields.isEmpty else { return nil }
        let body = fields.map { "\(json($0.0)):\($0.1)" }.joined(separator: ",")
        return "{\(body)}"
    }
}

private func intValue(_ raw: Any?) -> Int? {
    if let int = raw as? Int { return int }
    if let number = raw as? NSNumber { return number.intValue }
    return nil
}
