import Testing

@testable import HelperCore

@Suite("Unicode post routing")
struct UnicodePostRoutingTests {
    @Test("a live pid prefers the pid route")
    func pidPresent() {
        let route = UnicodePostRouting.route(processId: 4242, processIsRunning: { $0 == 4242 })
        #expect(route == .pid(4242))
    }

    @Test("no pid falls back to the global tap")
    func noPid() {
        #expect(UnicodePostRouting.route(processId: nil, processIsRunning: { _ in true }) == .globalTap)
        #expect(UnicodePostRouting.route(processId: 0, processIsRunning: { _ in true }) == .globalTap)
        #expect(UnicodePostRouting.route(processId: -1, processIsRunning: { _ in true }) == .globalTap)
    }

    @Test("a dead pid falls back to the global tap")
    func deadPid() {
        #expect(
            UnicodePostRouting.route(processId: 99, processIsRunning: { _ in false }) == .globalTap
        )
    }
}
