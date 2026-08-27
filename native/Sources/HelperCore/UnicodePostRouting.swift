/// Where a Unicode key event should be posted.
///
/// Idea from FluidVoice posting Unicode events to a pid instead of the global
/// HID stream; reimplemented as a pure routing decision against this ladder.
/// No source copied.
///
/// Delivering to one process's event queue bypasses the global stream and
/// every event tap sitting on it, which is the layer that coalesced the
/// 2026-08-09 cmux burst. Some apps ignore pid-posted events, which is why
/// the inserter still falls back to the global tap when this says `.globalTap`
/// **or** when posting to the pid fails before any event is sent.
///
/// `CGEvent.postToPid` does not return a status. "Failure" here is therefore
/// *before* posting: no pid, pid 0, or the process has already exited
/// (`kill(pid, 0)` → `ESRCH`). We do not retry on the global tap after events
/// have been posted — that would double-type.

import Darwin
import Foundation

public enum UnicodePostRoute: Equatable, Sendable {
    case pid(Int32)
    case globalTap
}

public enum UnicodePostRouting {
    /// Prefer the target process when we have a live pid.
    public static func route(processId: Int32?, processIsRunning: (Int32) -> Bool = isProcessRunning)
        -> UnicodePostRoute
    {
        guard let pid = processId, pid > 0, processIsRunning(pid) else {
            return .globalTap
        }
        return .pid(pid)
    }

    public static func isProcessRunning(_ pid: Int32) -> Bool {
        // `kill(pid, 0)` is a liveness probe: it does not signal, it asks
        // whether the pid exists. EPERM means it exists and we cannot signal
        // it, which is still a live process. ESRCH means it is gone.
        if kill(pid, 0) == 0 { return true }
        return errno != ESRCH
    }
}
