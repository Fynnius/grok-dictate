import Foundation
import Testing

@testable import CaptureCore

@Suite("Capture protocol")
struct CaptureProtocolTests {
    @Test("decodes start, stop and cancel")
    func decodesCommands() {
        let start = CaptureCommandDecoder.decode(
            line: #"{"type":"start","sessionId":"s1","sampleRate":16000,"chunkBytes":3200}"#
        )
        #expect(start == .command(.start(sessionId: "s1", sampleRate: 16_000, chunkBytes: 3200)))

        let stop = CaptureCommandDecoder.decode(line: #"{"type":"stop","sessionId":"s1"}"#)
        #expect(stop == .command(.stop(sessionId: "s1")))

        let cancel = CaptureCommandDecoder.decode(line: #"{"type":"cancel","sessionId":"s1"}"#)
        #expect(cancel == .command(.cancel(sessionId: "s1")))
    }

    @Test("unknown types and malformed lines are values, not traps")
    func unknownAndMalformed() {
        #expect(CaptureCommandDecoder.decode(line: #"{"type":"from_the_future"}"#) == .unknownType("from_the_future"))
        #expect(CaptureCommandDecoder.decode(line: "this is not json") == .malformed(reason: "not JSON"))
        #expect(CaptureCommandDecoder.decode(line: "[1,2,3]") == .malformed(reason: "top-level value is not a JSON object"))
        #expect(CaptureCommandDecoder.decode(line: "") == .malformed(reason: "empty line"))
        #expect(
            CaptureCommandDecoder.decode(line: #"{"type":"start","sessionId":"s1"}"#)
                == .malformed(reason: "start is missing a positive sampleRate")
        )
    }

    @Test("unknown fields on a known type are ignored")
    func unknownFields() {
        let decoded = CaptureCommandDecoder.decode(
            line: #"{"type":"stop","sessionId":"s1","micProcessing":true,"extra":[1]}"#
        )
        #expect(decoded == .command(.stop(sessionId: "s1")))
    }

    @Test("started encodes with a trailing newline and no embedded newline")
    func startedEncoding() throws {
        let line = CaptureFrame.started(sessionId: "s1", actualSampleRate: 16_000).encoded()
        #expect(line.hasSuffix("\n"))
        #expect(line.dropLast().contains("\n") == false)
        let object = try decode(line)
        #expect(object["type"] as? String == "started")
        #expect(object["sessionId"] as? String == "s1")
        #expect(object["actualSampleRate"] as? Int == 16_000)
        // No device was supplied: backward compatible with a decoder that
        // has never heard of the field, so it is left off entirely rather
        // than sent as `null`.
        #expect(object["device"] == nil)
    }

    @Test("started carries the device when CoreAudio could describe it")
    func startedWithDevice() throws {
        let device = CaptureDeviceInfo(
            transport: "bluetooth",
            sampleRateHz: 48_000
        )
        let line = CaptureFrame.started(
            sessionId: "s1", actualSampleRate: 16_000, device: device
        ).encoded()
        let object = try decode(line)
        let encodedDevice = try #require(object["device"] as? [String: Any])
        #expect(encodedDevice["transport"] as? String == "bluetooth")
        #expect((encodedDevice["sampleRateHz"] as? NSNumber)?.doubleValue == 48_000)
        // No name or UID: a Bluetooth UID embeds the device's MAC address
        // and main.log gets pasted into public GitHub issues.
        #expect(encodedDevice["name"] == nil)
        #expect(encodedDevice["uid"] == nil)
    }

    @Test("a device with every field nil is omitted rather than sent as {}")
    func startedWithEmptyDevice() throws {
        let device = CaptureDeviceInfo(transport: nil, sampleRateHz: nil)
        let line = CaptureFrame.started(
            sessionId: "s1", actualSampleRate: 16_000, device: device
        ).encoded()
        let object = try decode(line)
        #expect(object["device"] == nil)
    }

    @Test("a device with only some fields known omits the rest")
    func startedWithPartialDevice() throws {
        let device = CaptureDeviceInfo(transport: nil, sampleRateHz: 48_000)
        let line = CaptureFrame.started(
            sessionId: "s1", actualSampleRate: 16_000, device: device
        ).encoded()
        let object = try decode(line)
        let encodedDevice = try #require(object["device"] as? [String: Any])
        #expect((encodedDevice["sampleRateHz"] as? NSNumber)?.doubleValue == 48_000)
        #expect(encodedDevice["transport"] == nil)
    }

    @Test("transport types bucket to the categories W0 cares about, and anything else is unknown")
    func transportBucketing() {
        #expect(CaptureDeviceTransportBucket.bucket(rawTransportType: 1_651_274_862) == "built_in")
        #expect(CaptureDeviceTransportBucket.bucket(rawTransportType: 1_651_275_109) == "bluetooth")
        #expect(CaptureDeviceTransportBucket.bucket(rawTransportType: 1_651_271_009) == "bluetooth_le")
        #expect(CaptureDeviceTransportBucket.bucket(rawTransportType: 1_970_496_032) == "usb")
        #expect(CaptureDeviceTransportBucket.bucket(rawTransportType: 1_735_554_416) == "aggregate")
        #expect(CaptureDeviceTransportBucket.bucket(rawTransportType: 1_986_622_068) == "virtual")
        // Thunderbolt, FireWire, PCI, DisplayPort, AVB, and anything future.
        #expect(CaptureDeviceTransportBucket.bucket(rawTransportType: 0) == "unknown")
        #expect(CaptureDeviceTransportBucket.bucket(rawTransportType: UInt32.max) == "unknown")
    }

    @Test("chunk round-trips PCM as base64")
    func chunkEncoding() throws {
        let pcm = Data([0x00, 0x80, 0xFF, 0x7F])
        let line = CaptureFrame.chunk(sessionId: "s1", pcm: pcm).encoded()
        let object = try decode(line)
        #expect(object["type"] as? String == "chunk")
        let encoded = try #require(object["pcm"] as? String)
        #expect(Data(base64Encoded: encoded) == pcm)
        #expect(encoded.contains("\n") == false)
    }

    @Test("error carries a machine code and a hint")
    func errorEncoding() throws {
        let line = CaptureFrame.error(
            sessionId: "s1",
            code: .audioPermission,
            message: "not allowed",
            hint: "grant it"
        ).encoded()
        let object = try decode(line)
        #expect(object["code"] as? String == "audio_permission")
        #expect(object["message"] as? String == "not allowed")
        #expect(object["hint"] as? String == "grant it")
    }

    @Test("level is clamped to 0...1")
    func levelClamped() throws {
        let high = try decode(CaptureFrame.level(sessionId: "s1", level: 4).encoded())
        #expect((high["level"] as? NSNumber)?.doubleValue == 1)
        let nan = try decode(CaptureFrame.level(sessionId: "s1", level: .nan).encoded())
        #expect((nan["level"] as? NSNumber)?.doubleValue == 0)
    }

    private func decode(_ line: String) throws -> [String: Any] {
        let data = try #require(line.data(using: .utf8))
        return try #require(JSONSerialization.jsonObject(with: data) as? [String: Any])
    }
}
