/// The helper-side port for muting system output while recording.
///
/// The real implementation lives in the executable (`OutputMute.swift`) because
/// it talks to CoreAudio. This protocol is what `CommandRouter` depends on, so
/// the mute commands are unit-testable with a spy and never have to touch a
/// device from HelperCoreTests.
///
/// Idea from FluidVoice's "don't leave the user muted" restore discipline;
/// reimplemented against this helper's command router. No source copied.

public protocol OutputMuting: AnyObject, Sendable {
    func mute()
    func unmute()
}

/// Default for tests that do not care about mute. Does nothing.
public final class NullOutputMute: OutputMuting, @unchecked Sendable {
    public init() {}
    public func mute() {}
    public func unmute() {}
}
