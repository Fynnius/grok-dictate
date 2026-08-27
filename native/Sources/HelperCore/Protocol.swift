/// The wire protocol, Swift side.
///
/// Mirrors `contracts/helper-protocol.md` and `contracts/helper-protocol.ts`,
/// which are FROZEN. Where this file and the `.ts` disagree, the `.ts` wins —
/// it is what the app parses with, and a mismatch here is a Phase 2 defect.
///
/// Two rules from contract §1 shape every decision below:
///
///   1. A malformed line must never crash either side. So decoding returns a
///      value (`DecodedCommand`), never throws, and never traps.
///   2. Unknown `type` values and unknown *fields* on a known type are ignored,
///      not fatal. That is the forward-compatibility seam.
///
/// Decoding therefore goes through `JSONSerialization` into a dictionary and is
/// hand-validated, rather than through `Codable`. `Codable` would make rule 3
/// (ignore unknown fields) automatic but rule 2 (ignore unknown *types*)
/// awkward, and it gives far worse diagnostic text — and diagnostic text is the
/// whole point of a `log` frame that says *why* a line was dropped.

import Foundation

public enum Protocols {
    /// Every frame carries this. A frame with a different `v` is rejected, not
    /// coerced (contract §1).
    public static let version = 1
}

// MARK: - Vocabulary

public enum HotkeyAction: String, Sendable, CaseIterable {
    case pttDown = "ptt_down"
    case pttUp = "ptt_up"
    case toggle
    case retryInsert = "retry_insert"
}

/// Contract §2. `ax` reports success only when the caret proved it; `unicode`
/// posts synthetic key events and then checks the target's text length, which
/// answers "landed", "did not land" or "cannot tell" — see `verified` below;
/// `none` means nothing was attempted or everything failed, and the
/// clipboard has *not* been touched.
public enum InsertTier: String, Sendable {
    case ax
    case unicode
    case none
}

/// The `verified` field on `insert_result` (contract §2), added for BUG-1.
///
/// The invariant the whole fix rests on: **`ok: true` with `verified` not `true`
/// means "typed, unconfirmed"** — a state the app stops presenting as plain
/// success. Before this existed there was no way to say it on the wire, so a
/// Unicode burst the target dropped and a Unicode burst that landed were the
/// same frame.
///
/// `notPossible` is deliberately the same value an older helper build produces
/// (absent → `null`), because "this build cannot tell you" and "this target
/// cannot be measured" are the same claim from the app's side.
public enum InsertionVerification: Sendable, Equatable {
    /// The helper confirmed the text landed: the caret moved (AX), or the
    /// focused element's text grew by what was typed (Unicode).
    case confirmed
    /// Verification ran and proved nothing landed. Reported with `ok: false`
    /// and `reason: "verification_failed"`.
    case provenNotLanded
    /// No verification was possible for this target — no readable length, no
    /// resolvable focus, or verification switched off.
    case notPossible

    /// `true` / `false` / `null` on the wire, in that order.
    public var wireValue: Bool? {
        switch self {
        case .confirmed: return true
        case .provenNotLanded: return false
        case .notPossible: return nil
        }
    }
}

/// Why an insert was declined, in a form the app can branch on.
///
/// Added in Phase 5. `error` is prose written for a human, so the app had no
/// way to tell "focus moved to another application" apart from "neither tier
/// worked" — and therefore showed the wrong advice. See `contracts/helper-protocol.md` §2.
public enum InsertDeclineReason: String, Sendable {
    /// The frontmost app is no longer the one the request named (§11.1.10).
    case targetChanged = "target_changed"
    /// There was nothing to insert.
    case emptyText = "empty_text"
    /// AX declined and Unicode injection failed.
    case noTier = "no_tier"
    /// The Unicode tier posted its events and the target's text did not change,
    /// so the insertion is proven not to have landed. Added for BUG-1; it is
    /// what turns the incident's green "Inserted" pill into the app's existing
    /// not-inserted HUD, error cue and re-insert path.
    case verificationFailed = "verification_failed"
}

public enum LogLevel: String, Sendable {
    case info
    case warn
    case error
}

/// What this build can actually attempt, sent in `ready.caps`.
public enum HelperCapability: String, Sendable {
    case ax
    case unicode
}

// MARK: - Helper → App

public enum HelperFrame: Sendable, Equatable {
    case ready(version: String, caps: [HelperCapability])
    case hotkey(action: HotkeyAction, timestampMs: Int)
    case secureInput(enabled: Bool)
    /// `id` is `nil` for the unsolicited push emitted when the frontmost app
    /// changes, and set when answering a `get_frontmost` (contract §2).
    case frontmost(bundleId: String?, name: String?, id: String?)
    /// `verified` is `true` / `false` / `null`, never absent — unlike
    /// `frontmost.id`, the app parses it with Zod's `.nullish()`, which accepts
    /// both, and a field that is always present is one less shape to reason
    /// about when reading a log by eye (contract §5).
    case insertResult(
        id: String,
        tier: InsertTier,
        ok: Bool,
        verified: Bool?,
        error: String?,
        reason: InsertDeclineReason?,
        frontmostBundleId: String?,
        frontmostName: String?
    )
    /// Whether the helper can actually do its job. Contract §2; added in
    /// Phase 5 so the tray stops claiming "Ready" while the event tap failed to
    /// install and the Fn key is dead.
    case permissions(accessibility: Bool, hotkeyActive: Bool)
    case log(level: LogLevel, message: String)

    /// One NDJSON line, newline included.
    ///
    /// Assembled field by field rather than handed to `JSONSerialization` as a
    /// dictionary, for one reason: **key order**. A Swift `Dictionary` has no
    /// order, so the serialised form varies between runs, and contract §5 keeps
    /// bare NDJSON specifically because it is "trivially debuggable by eye".
    /// Frames whose keys shuffle are not. `v` and `type` lead every frame here,
    /// and the rest follow the contract's own order.
    ///
    /// Every *string value* still goes through `JSONSerialization`, so the
    /// escaping is Foundation's and not hand-rolled. That matters more than it
    /// looks: transcripts routinely contain quotes, backslashes and newlines,
    /// and the entire framing rests on those being escaped rather than emitted
    /// raw (contract §1). The result contains exactly one newline — the
    /// terminator.
    public func encoded() -> String {
        var fields: [(String, String)] = [
            ("v", String(Protocols.version))
        ]

        switch self {
        case let .ready(version, caps):
            fields.append(("type", Self.json("ready")))
            fields.append(("version", Self.json(version)))
            fields.append(("caps", "[" + caps.map { Self.json($0.rawValue) }.joined(separator: ",") + "]"))
        case let .hotkey(action, timestampMs):
            fields.append(("type", Self.json("hotkey")))
            fields.append(("action", Self.json(action.rawValue)))
            fields.append(("ts", String(timestampMs)))
        case let .secureInput(enabled):
            fields.append(("type", Self.json("secure_input")))
            fields.append(("enabled", enabled ? "true" : "false"))
        case let .frontmost(bundleId, name, id):
            fields.append(("type", Self.json("frontmost")))
            fields.append(("bundleId", bundleId.map(Self.json) ?? "null"))
            fields.append(("name", name.map(Self.json) ?? "null"))
            // Absent, not null, when unsolicited: the contract types it
            // `.optional()`, and `null` would fail the app's Zod parse.
            if let id { fields.append(("id", Self.json(id))) }
        case let .insertResult(
            id, tier, ok, verified, error, reason, frontmostBundleId, frontmostName
        ):
            fields.append(("type", Self.json("insert_result")))
            fields.append(("id", Self.json(id)))
            fields.append(("tier", Self.json(tier.rawValue)))
            fields.append(("ok", ok ? "true" : "false"))
            // Immediately after `ok`, because it qualifies it: `ok: true` with
            // `verified: null` is "typed, unconfirmed", and the two belong next
            // to each other in a line somebody is reading by eye.
            fields.append(("verified", verified.map { $0 ? "true" : "false" } ?? "null"))
            fields.append(("error", error.map(Self.json) ?? "null"))
            fields.append(("reason", reason.map { Self.json($0.rawValue) } ?? "null"))
            fields.append(("frontmostBundleId", frontmostBundleId.map(Self.json) ?? "null"))
            fields.append(("frontmostName", frontmostName.map(Self.json) ?? "null"))
        case let .permissions(accessibility, hotkeyActive):
            fields.append(("type", Self.json("permissions")))
            fields.append(("accessibility", accessibility ? "true" : "false"))
            fields.append(("hotkeyActive", hotkeyActive ? "true" : "false"))
        case let .log(level, message):
            fields.append(("type", Self.json("log")))
            fields.append(("level", Self.json(level.rawValue)))
            fields.append(("msg", Self.json(message)))
        }

        let body = fields.map { "\(Self.json($0.0)):\($0.1)" }.joined(separator: ",")
        return "{\(body)}\n"
    }

    /// One JSON string literal, quotes and escaping included.
    private static func json(_ value: String) -> String {
        guard
            let data = try? JSONSerialization.data(
                withJSONObject: value,
                options: [.fragmentsAllowed]
            ),
            let literal = String(data: data, encoding: .utf8)
        else {
            // Unreachable for any `String`. But "unreachable" plus a crash is
            // how a hotkey dies silently, so degrade to something that parses.
            return "\"\""
        }
        return literal
    }
}

// MARK: - App → Helper

public enum AppCommand: Sendable, Equatable {
    case insert(id: String, text: String, targetBundleId: String?)
    case copy(text: String)
    case getFrontmost(id: String)
    case setHotkeys(ptt: String, toggle: String, retry: String)
    case shutdown
    /// Mute default output. Added 2026-08-22. Fire-and-forget, like `copy`.
    case muteOutput
    /// Restore after `muteOutput`. Idempotent.
    case unmuteOutput
}

/// The total result of decoding one line. Every case is a value the caller can
/// act on; nothing here throws (contract §1 rule 1).
public enum DecodedCommand: Sendable, Equatable {
    case command(AppCommand)
    /// A well-formed frame whose `type` this build does not know. Contract §1
    /// rule 2: degrade, do not die.
    case unknownType(String)
    /// Not JSON, not an object, wrong `v`, or a known type missing a required
    /// field. `reason` becomes the text of a `log` frame.
    case malformed(reason: String)
}

public enum CommandDecoder {
    public static func decode(line: String) -> DecodedCommand {
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

        // `v` is checked before `type`, so a future protocol version is
        // rejected as a version problem rather than misreported as an unknown
        // type. Rejected, not coerced (contract §1).
        guard let version = object["v"] as? Int else {
            return .malformed(reason: "missing or non-numeric \"v\"")
        }
        guard version == Protocols.version else {
            return .malformed(
                reason: "unsupported protocol version \(version); this helper speaks v\(Protocols.version)"
            )
        }
        guard let type = object["type"] as? String else {
            return .malformed(reason: "missing or non-string \"type\"")
        }

        switch type {
        case "insert":
            guard let id = nonEmptyString(object["id"]) else {
                return .malformed(reason: "insert is missing a non-empty \"id\"")
            }
            guard let text = object["text"] as? String else {
                return .malformed(reason: "insert is missing a string \"text\"")
            }
            // `targetBundleId` is `string | null` and required by the contract,
            // but a missing key is treated as null rather than rejected: null
            // and absent both mean "do not check the target", so failing here
            // would drop an insert — and a dropped insert loses a transcript.
            let target = nullableString(object["targetBundleId"])
            return .command(.insert(id: id, text: text, targetBundleId: target))

        case "copy":
            guard let text = object["text"] as? String else {
                return .malformed(reason: "copy is missing a string \"text\"")
            }
            return .command(.copy(text: text))

        case "get_frontmost":
            guard let id = nonEmptyString(object["id"]) else {
                return .malformed(reason: "get_frontmost is missing a non-empty \"id\"")
            }
            return .command(.getFrontmost(id: id))

        case "set_hotkeys":
            guard
                let ptt = nonEmptyString(object["ptt"]),
                let toggle = nonEmptyString(object["toggle"]),
                let retry = nonEmptyString(object["retry"])
            else {
                return .malformed(
                    reason: "set_hotkeys needs non-empty \"ptt\", \"toggle\" and \"retry\""
                )
            }
            return .command(.setHotkeys(ptt: ptt, toggle: toggle, retry: retry))

        case "shutdown":
            return .command(.shutdown)

        case "mute_output":
            return .command(.muteOutput)

        case "unmute_output":
            return .command(.unmuteOutput)

        default:
            return .unknownType(type)
        }
    }

    private static func nonEmptyString(_ value: Any?) -> String? {
        guard let string = value as? String, !string.isEmpty else { return nil }
        return string
    }

    /// `nil` for both an explicit JSON `null` and an absent key.
    private static func nullableString(_ value: Any?) -> String? {
        guard let value, !(value is NSNull) else { return nil }
        return value as? String
    }
}
