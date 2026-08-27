/// Dispatches one decoded app→helper command.
///
/// The seam that makes the protocol testable end-to-end: `handle(line:)` takes
/// raw NDJSON and emits real frames, so the malformed-input rules from contract
/// §1 are exercised by the same code path production uses, rather than by a
/// test-only shortcut.

import Foundation

public final class CommandRouter {
    public enum Effect: Sendable, Equatable {
        case shutdown
    }

    private let insertion: InsertionPerforming
    private let pasteboard: PasteboardWriting
    private let frontmost: FrontmostAppProviding
    private let outputMute: OutputMuting
    private let emit: (HelperFrame) -> Void
    private let onHotkeysChanged: (HotkeyConfiguration) -> Void

    public private(set) var hotkeys: HotkeyConfiguration

    public init(
        insertion: InsertionPerforming,
        pasteboard: PasteboardWriting,
        frontmost: FrontmostAppProviding,
        outputMute: OutputMuting = NullOutputMute(),
        hotkeys: HotkeyConfiguration = .default,
        emit: @escaping (HelperFrame) -> Void,
        onHotkeysChanged: @escaping (HotkeyConfiguration) -> Void = { _ in }
    ) {
        self.insertion = insertion
        self.pasteboard = pasteboard
        self.frontmost = frontmost
        self.outputMute = outputMute
        self.hotkeys = hotkeys
        self.emit = emit
        self.onHotkeysChanged = onHotkeysChanged
    }

    /// Handle one raw line. Never throws, never traps — contract §1 rule 1.
    @discardableResult
    public func handle(line: String) -> [Effect] {
        handle(decoded: CommandDecoder.decode(line: line))
    }

    @discardableResult
    public func handle(decoded: DecodedCommand) -> [Effect] {
        switch decoded {
        case let .command(command):
            return handle(command: command)

        case let .unknownType(type):
            // Contract §1 rule 2 — the forward-compatibility seam. A newer app
            // talking to an older helper degrades instead of dying.
            emit(.log(level: .warn, message: "ignoring unknown command type \"\(type)\""))
            return []

        case let .malformed(reason):
            emit(.log(level: .warn, message: "ignoring malformed line: \(reason)"))
            return []
        }
    }

    private func handle(command: AppCommand) -> [Effect] {
        switch command {
        case let .insert(id, text, targetBundleId):
            insertion.perform(text: text, targetBundleId: targetBundleId) { [emit] outcome in
                emit(
                    .insertResult(
                        id: id,
                        tier: outcome.tier,
                        ok: outcome.ok,
                        // The one place the ladder's three-way verification
                        // becomes the wire's `true | false | null` (contract §2).
                        verified: outcome.verification.wireValue,
                        error: outcome.error,
                        reason: outcome.reason,
                        frontmostBundleId: outcome.frontmost?.bundleId,
                        frontmostName: outcome.frontmost?.name
                    )
                )
            }
            return []

        case let .copy(text):
            // The ONLY pasteboard write in the application.
            // Logged at info with a character count and never the text itself:
            // the transcript may be anything the user said, and this line goes
            // through the app's log sinks.
            pasteboard.write(text)
            emit(
                .log(
                    level: .info,
                    message: "wrote \(text.count) characters to the pasteboard on explicit request"
                )
            )
            return []

        case let .getFrontmost(id):
            let app = frontmost.frontmostApp
            emit(.frontmost(bundleId: app.bundleId, name: app.name, id: id))
            return []

        case let .setHotkeys(ptt, toggle, retry):
            let warnings = hotkeys.apply(ptt: ptt, toggle: toggle, retry: retry)
            for warning in warnings {
                emit(.log(level: .warn, message: warning))
            }
            onHotkeysChanged(hotkeys)
            return []

        case .shutdown:
            // Restore before exit so a polite shutdown does not leave the
            // machine muted. Signal/crash paths restore in the executable.
            outputMute.unmute()
            return [.shutdown]

        case .muteOutput:
            outputMute.mute()
            return []

        case .unmuteOutput:
            outputMute.unmute()
            return []
        }
    }
}
