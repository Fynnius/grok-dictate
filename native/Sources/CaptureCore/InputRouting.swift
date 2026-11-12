/// Which microphone to open when the system default is a Bluetooth headset.
///
/// ## Why not just open the default
///
/// A Bluetooth headset's microphone only exists in the hands-free profile
/// (HFP). Opening it makes macOS tear down the headset's A2DP music stream,
/// renegotiate the link, and bring up an eSCO voice channel. Measured on
/// AirPods Pro (2026-11-12, `log show` of coreaudiod/bluetoothd against
/// `main.log`):
///
///   - The switch reconfigures the headset's *output* side, which stops the
///     capture engine ~150 ms after `start()` and posts
///     `AVAudioEngineConfigurationChange`; the rebuild that follows blocked
///     the capture process for 2–3 s, so short holds got no audio at all.
///   - After a stop/start during that handover, bluetoothd parks the route in
///     "Deferring route change … will retry when disconnect stack event fires"
///     for a disconnect event that never comes. The input device keeps
///     "running" and delivers exact digital silence — for every following
///     hold, however long the user waits — until the headset is reconnected.
///   - Even when it works, eSCO setup costs ~0.5–1 s before the first sample,
///     and music on the headset drops to call quality while the mic is open.
///
/// None of that happens if the headset stays in A2DP: the user keeps hearing
/// through it and we record from the Mac's own microphone, which is what
/// switching the system input to the built-in mic does by hand — scoped to
/// this app instead of the whole system.
///
/// ## When it does not apply
///
/// A closed lid hardware-disconnects the built-in microphone on current
/// MacBooks while CoreAudio still lists it, so with the lid shut the headset
/// is the only microphone that can hear the user. A Mac without a built-in
/// microphone has nothing to fall back to. Wired and USB microphones are
/// chosen deliberately and are left alone.
public enum InputRouting {
    /// - Returns: `true` when capture should pin the built-in microphone
    ///   instead of following the system default input.
    public static func shouldUseBuiltIn(
        preferBuiltInMic: Bool,
        defaultInputTransport: String?,
        hasBuiltInInput: Bool,
        lidClosed: Bool
    ) -> Bool {
        guard preferBuiltInMic, hasBuiltInInput, !lidClosed else { return false }
        return defaultInputTransport == "bluetooth" || defaultInputTransport == "bluetooth_le"
    }
}
