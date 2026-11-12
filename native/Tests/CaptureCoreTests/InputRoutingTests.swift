import CaptureCore
import Testing

@Suite("InputRouting")
struct InputRoutingTests {
    private func decide(
        prefer: Bool = true,
        transport: String? = "bluetooth",
        builtIn: Bool = true,
        lidClosed: Bool = false
    ) -> Bool {
        InputRouting.shouldUseBuiltIn(
            preferBuiltInMic: prefer,
            defaultInputTransport: transport,
            hasBuiltInInput: builtIn,
            lidClosed: lidClosed
        )
    }

    @Test("a Bluetooth default input is swapped for the built-in microphone")
    func bluetoothSwapsToBuiltIn() {
        #expect(decide(transport: "bluetooth"))
        #expect(decide(transport: "bluetooth_le"))
    }

    @Test("every other default input is left alone")
    func otherTransportsFollowDefault() {
        for transport in ["built_in", "usb", "aggregate", "virtual", "unknown"] {
            #expect(decide(transport: transport) == false)
        }
        #expect(decide(transport: nil) == false)
    }

    @Test("the setting turned off always follows the default")
    func settingOff() {
        #expect(decide(prefer: false) == false)
    }

    @Test("no usable built-in microphone means the headset is the only choice")
    func noBuiltInOrLidClosed() {
        #expect(decide(builtIn: false) == false)
        #expect(decide(lidClosed: true) == false)
    }
}
