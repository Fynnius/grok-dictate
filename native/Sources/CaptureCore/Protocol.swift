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

public enum CaptureFrame: Sendable, Equatable {
    case started(sessionId: String, actualSampleRate: Int)
    case chunk(sessionId: String, pcm: Data)
    case level(sessionId: String, level: Double)
    case drained(sessionId: String)
    case error(sessionId: String, code: CaptureErrorCode, message: String, hint: String)

    /// One NDJSON line, newline included. `type` leads so a log is readable by eye.
    public func encoded() -> String {
        var fields: [(String, String)] = []
        switch self {
        case let .started(sessionId, actualSampleRate):
            fields.append(("type", Self.json("started")))
            fields.append(("sessionId", Self.json(sessionId)))
            fields.append(("actualSampleRate", String(actualSampleRate)))
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
}

private func intValue(_ raw: Any?) -> Int? {
    if let int = raw as? Int { return int }
    if let number = raw as? NSNumber { return number.intValue }
    return nil
}
