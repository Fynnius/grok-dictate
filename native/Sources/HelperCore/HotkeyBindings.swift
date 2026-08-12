/// The three hotkey slots and the strings the app is allowed to put in them.
///
/// Contract §3, `set_hotkeys`: "Values are lower-case, `+`-separated tokens. v1
/// recognises exactly `fn`, `fn+space` and `ctrl+cmd+v`; an unrecognised
/// binding must be reported via `log` at `warn` and the previous binding kept,
/// **never silently ignored**." That last clause is the whole design of this
/// file: parsing produces warnings alongside a config, and an unparseable slot
/// leaves that slot untouched rather than falling back to a default.

import Foundation

public enum HotkeyBinding: Sendable, Equatable {
    /// Push-to-talk: the Fn modifier alone, observed through `.flagsChanged`
    ///.
    case fn
    /// Hands-free toggle: Space carrying the SecondaryFn flag.
    case fnSpace
    /// Re-run the insertion ladder against `lastTranscript`.
    case ctrlCmdV

    public var canonical: String {
        switch self {
        case .fn: "fn"
        case .fnSpace: "fn+space"
        case .ctrlCmdV: "ctrl+cmd+v"
        }
    }

    /// Token-set comparison rather than string equality, so `cmd+ctrl+v` is
    /// accepted as well as `ctrl+cmd+v`. A strict superset of the contract: the
    /// canonical spellings all parse, and nothing that should be rejected is
    /// now accepted.
    public static func parse(_ raw: String) -> HotkeyBinding? {
        let tokens = Set(
            raw.lowercased()
                .split(separator: "+")
                .map { $0.trimmingCharacters(in: .whitespaces) }
                .filter { !$0.isEmpty }
        )
        switch tokens {
        case ["fn"]: return .fn
        case ["fn", "space"]: return .fnSpace
        case ["ctrl", "cmd", "v"]: return .ctrlCmdV
        default: return nil
        }
    }
}

public struct HotkeyConfiguration: Sendable, Equatable {
    public var ptt: HotkeyBinding
    public var toggle: HotkeyBinding
    public var retry: HotkeyBinding

    /// The defaults from `contracts/config.ts`. The helper starts with these
    /// armed, so the Fn key works before the app's first `set_hotkeys` arrives.
    public static let `default` = HotkeyConfiguration(ptt: .fn, toggle: .fnSpace, retry: .ctrlCmdV)

    public init(ptt: HotkeyBinding, toggle: HotkeyBinding, retry: HotkeyBinding) {
        self.ptt = ptt
        self.toggle = toggle
        self.retry = retry
    }

    /// Apply a `set_hotkeys` command. Each slot is validated independently, so
    /// one bad value does not discard two good ones.
    ///
    /// v1 accepts exactly one binding per slot. A hold and a chord are not
    /// interchangeable — `ptt` has to be something whose press and release are
    /// both observable, which among the three is only `fn` — so a
    /// slot/binding mismatch is rejected with the same "kept the previous
    /// value" rule as an unparseable string.
    public mutating func apply(ptt: String, toggle: String, retry: String) -> [String] {
        var warnings: [String] = []
        assign(raw: ptt, slot: "ptt", accepting: .fn, into: &self.ptt, warnings: &warnings)
        assign(raw: toggle, slot: "toggle", accepting: .fnSpace, into: &self.toggle, warnings: &warnings)
        assign(raw: retry, slot: "retry", accepting: .ctrlCmdV, into: &self.retry, warnings: &warnings)
        return warnings
    }

    private func assign(
        raw: String,
        slot: String,
        accepting accepted: HotkeyBinding,
        into target: inout HotkeyBinding,
        warnings: inout [String]
    ) {
        guard let parsed = HotkeyBinding.parse(raw) else {
            warnings.append(
                "ignoring unrecognised \(slot) hotkey \"\(raw)\"; keeping \"\(target.canonical)\". "
                    + "v1 supports only \"\(accepted.canonical)\" for \(slot)."
            )
            return
        }
        guard parsed == accepted else {
            warnings.append(
                "ignoring \(slot) hotkey \"\(raw)\"; keeping \"\(target.canonical)\". "
                    + "v1 supports only \"\(accepted.canonical)\" for \(slot)."
            )
            return
        }
        target = parsed
    }
}
