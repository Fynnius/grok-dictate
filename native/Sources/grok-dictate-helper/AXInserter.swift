/// Tier 1 of the ladder: the Accessibility API.
///
/// `AXUIElementCreateSystemWide()` → `kAXFocusedUIElementAttribute` → set
/// `kAXSelectedTextAttribute`. Setting the
/// *selected text* is an insert-at-caret when nothing is selected and a replace
/// when something is, which is exactly dictation's semantics.
///
/// This is the only tier that returns an error code, so it is the only tier
/// whose success is real. Every failure below carries the actual `AXError`
/// spelled out, because that value is what settles  (does Secure
/// Input block AX writes, or only event taps?) and because
/// IMPLEMENTATION-PLAN.md §4 requires "STT failed" to never be an acceptable
/// error message.
///
/// Expected to fail in Electron apps and terminals — that is
/// not a bug, it is why there is a tier 2.
///
/// **The write's return code is not, on its own, evidence that the text went
/// in.** Two applications are now known to return `kAXErrorSuccess` and insert
/// nothing: terminals, which at least admit the attribute is not settable and
/// are stopped by `AXSelectedTextGate`; and Arc's web content, which admits
/// nothing and is stopped by reading the caret back — see `AXWriteVerification`
/// for the log that caught it and the reasoning behind the policy.

import ApplicationServices
import Foundation
import HelperCore

final class AXInserter: AccessibilityInserting {
    /// Read the caret back after the write and only report success if it moved.
    /// Off only via `GROK_DICTATE_AX_VERIFY=0`, which exists so the check can be
    /// bisected in a live session — turning it off restores the Arc behaviour
    /// where dictated text vanishes behind `tier: ax, ok: true`.
    private let verifyWrites: Bool
    private let log: (LogLevel, String) -> Void

    init(verifyWrites: Bool = true, log: @escaping (LogLevel, String) -> Void = { _, _ in }) {
        self.verifyWrites = verifyWrites
        self.log = log
    }

    /// Cap on how long a single AX round-trip may block. The AX API is
    /// synchronous IPC into the target application, so a hung app would
    /// otherwise hang this call indefinitely — and although insertion runs off
    /// the main thread, an unbounded stall would still wedge the serial
    /// insertion queue and every insert behind it.
    ///
    /// Bounded rather than measured: `--probe-ax` showed the application-element
    /// route works both with no explicit timeout and with 10 s, so the value is
    /// not load-bearing. Two seconds sits comfortably inside the app's own 15 s
    /// `INSERT_TIMEOUT_MS`, which a 10 s stall would eat most of.
    private static let messagingTimeout: Float = 2.0

    func insertSelectedText(_ text: String, into app: FrontmostAppInfo) -> TierAttempt {
        guard AXIsProcessTrusted() else {
            return .failed(
                reason:
                    "Accessibility permission is not granted — open System Settings → Privacy & "
                    + "Security → Accessibility and enable Grok Dictate"
            )
        }

        // MEASURED, and the obvious implementation is the wrong one.
        //
        // The natural route is `AXUIElementCreateSystemWide()` →
        // `kAXFocusedUIElementAttribute`, which is what this file did first. On
        // macOS 26 that returns `kAXErrorCannotComplete (-25204)` in *every*
        // application tested — Notes, TextEdit, Safari, Cursor — with the
        // process trusted and regardless of the messaging timeout (1 s, default
        // and 10 s all fail). Going through the application element instead
        // succeeds immediately: `AXTextArea`, `kAXSelectedText` settable, the
        // write returning `kAXErrorSuccess`.
        //
        // Evidence: `--probe-ax` in Probes.swift, run against Notes, recorded in
        // docs/phase-2-report.md §4 HT-3. Without this the AX tier never fires
        // and the ladder is silently Unicode-only — the contract's "`ax` is the
        // only tier whose `ok` is trustworthy" would have been true and useless.
        //
        // System-wide is still tried as a fallback: it costs one call, and an
        // app where it works but the application element does not is cheaper to
        // absorb here than to discover in the field.
        var failures: [String] = []

        if let processId = app.processId {
            let application = AXUIElementCreateApplication(processId)
            AXUIElementSetMessagingTimeout(application, Self.messagingTimeout)
            switch focusedElement(of: application) {
            case let .success(element):
                return write(text, to: element, in: app, route: "application element")
            case let .failure(reason):
                failures.append("application element: \(reason)")
            }
        } else {
            failures.append("application element: the frontmost app reported no pid")
        }

        let systemWide = AXUIElementCreateSystemWide()
        AXUIElementSetMessagingTimeout(systemWide, Self.messagingTimeout)
        switch focusedElement(of: systemWide) {
        case let .success(element):
            return write(text, to: element, in: app, route: "system-wide element")
        case let .failure(reason):
            failures.append("system-wide: \(reason)")
        }

        return .failed(reason: "no focused element (\(failures.joined(separator: "; ")))")
    }

    private enum FocusedElement {
        case success(AXUIElement)
        case failure(String)
    }

    private func focusedElement(of root: AXUIElement) -> FocusedElement {
        var focusedValue: CFTypeRef?
        let copyError = AXUIElementCopyAttributeValue(
            root,
            kAXFocusedUIElementAttribute as CFString,
            &focusedValue
        )
        guard copyError == .success, let focusedValue else {
            return .failure("kAXFocusedUIElementAttribute returned \(describe(copyError))")
        }
        // Type-check before converting. A force cast here would turn a
        // surprising return value into a crash, and a crashed helper is a dead
        // hotkey.
        guard CFGetTypeID(focusedValue) == AXUIElementGetTypeID() else {
            return .failure("the focused element is not an AXUIElement")
        }
        return .success(unsafeBitCast(focusedValue, to: AXUIElement.self))
    }

    private func write(
        _ text: String,
        to element: AXUIElement,
        in app: FrontmostAppInfo,
        route: String
    ) -> TierAttempt {
        var isSettable: DarwinBoolean = false
        let settableError = AXUIElementIsAttributeSettable(
            element,
            kAXSelectedTextAttribute as CFString,
            &isSettable
        )

        // See `AXSelectedTextGate`. Terminal.app and cmux report the attribute
        // is not settable and then return kAXErrorSuccess from the write while
        // inserting nothing — so the gate has to be consulted *before* the
        // write, not used to explain it afterwards.
        guard
            AXSelectedTextGate.shouldAttemptWrite(
                settableCheckSucceeded: settableError == .success,
                isSettable: isSettable.boolValue
            )
        else {
            return .failed(
                reason:
                    "via the \(route), kAXSelectedTextAttribute is not settable — the write would "
                    + "report success and insert nothing (terminals do this)"
            )
        }

        // The caret before the write. Read *first*, and decline here rather
        // than after the write if it cannot be read: an element that will not
        // report its selected range can never be verified, and declining before
        // anything has been written is the one point at which falling through
        // to Unicode injection cannot possibly duplicate text. See
        // `AXWriteVerification.trustsWrite` for why "cannot verify" declines at
        // all.
        var caretBefore: AXSelectedRange?
        if verifyWrites {
            switch copySelectedRange(of: element) {
            case let .success(range):
                caretBefore = range
            case let .failure(reason):
                return .failed(
                    reason:
                        "via the \(route), the write was not attempted because it could not have "
                        + "been verified — \(reason). An AX write that cannot be read back is "
                        + "indistinguishable from one the app silently discards"
                )
            }
        }

        let setError = AXUIElementSetAttributeValue(
            element,
            kAXSelectedTextAttribute as CFString,
            text as CFTypeRef
        )

        guard setError == .success else {
            let settableNote =
                settableError == .success
                ? "settable=\(isSettable.boolValue)"
                : "settable check itself failed with \(describe(settableError))"
            return .failed(
                reason:
                    "via the \(route), setting kAXSelectedTextAttribute returned "
                    + "\(describe(setError)) (\(settableNote))"
            )
        }

        // `GROK_DICTATE_AX_VERIFY=0`: the pre-Phase-5 behaviour, trusting the
        // return code. Kept only so the check can be bisected.
        guard let caretBefore else { return .succeeded }

        var caretAfter: AXSelectedRange?
        var afterReadFailure: String?
        switch copySelectedRange(of: element) {
        case let .success(range): caretAfter = range
        case let .failure(reason): afterReadFailure = reason
        }

        let verdict = AXWriteVerification.verdict(
            before: caretBefore,
            after: caretAfter,
            insertedUTF16Count: text.utf16.count
        )
        if AXWriteVerification.trustsWrite(verdict) { return .succeeded }

        let target = app.name ?? app.bundleId ?? "the frontmost application"
        let evidence = afterReadFailure.map { "\(verdict.evidence) (\($0))" } ?? verdict.evidence

        if verdict.isDiscardedWrite {
            // A warning, not an info line, because this is a diagnosis of the
            // other application rather than a normal decline: it said the
            // attribute was settable, said the write succeeded, and did
            // nothing. Without a line like this the only trace of the Arc bug
            // was an 11 ms insert in the state-machine log.
            log(
                .warn,
                "\(target) accepted an AX write and discarded it — \(evidence). Falling through "
                    + "to Unicode injection; the text is not lost"
            )
            return .failed(
                reason:
                    "via the \(route), kAXSelectedTextAttribute reported settable and the write "
                    + "returned kAXErrorSuccess, but \(evidence)"
            )
        }

        log(
            .warn,
            "an AX write into \(target) returned success but could not be confirmed — \(evidence). "
                + "Falling through to Unicode injection, which will duplicate the text if the AX "
                + "write did land"
        )
        return .failed(reason: "via the \(route), the write could not be confirmed — \(evidence)")
    }
}

enum AXRangeRead {
    case success(AXSelectedRange)
    case failure(String)

    /// `nil` on failure, which is exactly what `AXWriteVerification.verdict`
    /// takes — it reads a missing range as "cannot verify" rather than as "no
    /// movement", and the difference is the whole policy.
    var range: AXSelectedRange? {
        if case let .success(range) = self { return range }
        return nil
    }
}

/// `kAXSelectedTextRange` as a plain pair of integers.
///
/// Shared with `--probe-ax` on purpose: the probe has to report exactly what the
/// insertion path saw, and a second copy of this unpacking is a second thing to
/// get wrong. Every failure carries the `AXError` or the type mismatch that
/// caused it, because "could not verify" with no reason attached is the kind of
/// decline that gets blamed on the check rather than on the application.
func copySelectedRange(of element: AXUIElement) -> AXRangeRead {
    var value: CFTypeRef?
    let error = AXUIElementCopyAttributeValue(
        element,
        kAXSelectedTextRangeAttribute as CFString,
        &value
    )
    guard error == .success, let value else {
        return .failure("kAXSelectedTextRange returned \(describe(error))")
    }
    guard CFGetTypeID(value) == AXValueGetTypeID() else {
        return .failure("kAXSelectedTextRange is not an AXValue")
    }
    let axValue = unsafeBitCast(value, to: AXValue.self)
    guard AXValueGetType(axValue) == .cfRange else {
        return .failure("kAXSelectedTextRange is an AXValue but not a CFRange")
    }
    var range = CFRange(location: 0, length: 0)
    guard AXValueGetValue(axValue, .cfRange, &range) else {
        return .failure("kAXSelectedTextRange could not be unpacked into a CFRange")
    }
    return .success(AXSelectedRange(location: range.location, length: range.length))
}

/// `AXError` prints as a bare integer, which is useless in a log line the user
/// may be asked to read back. Spelled out with the numeric value kept, because
/// the number is what matches Apple's headers.
func describe(_ error: AXError) -> String {
    let name: String
    switch error {
    case .success: name = "kAXErrorSuccess"
    case .failure: name = "kAXErrorFailure"
    case .illegalArgument: name = "kAXErrorIllegalArgument"
    case .invalidUIElement: name = "kAXErrorInvalidUIElement"
    case .invalidUIElementObserver: name = "kAXErrorInvalidUIElementObserver"
    case .cannotComplete: name = "kAXErrorCannotComplete"
    case .attributeUnsupported: name = "kAXErrorAttributeUnsupported"
    case .actionUnsupported: name = "kAXErrorActionUnsupported"
    case .notificationUnsupported: name = "kAXErrorNotificationUnsupported"
    case .notImplemented: name = "kAXErrorNotImplemented"
    case .notificationAlreadyRegistered: name = "kAXErrorNotificationAlreadyRegistered"
    case .notificationNotRegistered: name = "kAXErrorNotificationNotRegistered"
    case .apiDisabled: name = "kAXErrorAPIDisabled"
    case .noValue: name = "kAXErrorNoValue"
    case .parameterizedAttributeUnsupported: name = "kAXErrorParameterizedAttributeUnsupported"
    case .notEnoughPrecision: name = "kAXErrorNotEnoughPrecision"
    @unknown default: name = "an unrecognised AXError"
    }
    return "\(name) (\(error.rawValue))"
}
