/**
 * The wire protocol between the Electron app and the Swift helper. See
 * `helper-protocol.md` for the prose, the rationale and the rules that cannot
 * be expressed as types.
 *
 * Frozen at the end of Phase 1 (IMPLEMENTATION-PLAN.md §2) and reopened by
 * Phase 5, which made one change: `insert_result` now carries a machine-
 * readable `reason`. See `InsertDeclineReason` for why.
 *
 * Newline-delimited JSON over the helper's stdin/stdout. Every frame carries
 * `v: 1`. Parsing is total — `parseHelperFrame` never throws. A helper that
 * can crash the app on a malformed byte would take down the hotkey.
 */

import { z } from 'zod';

export const PROTOCOL_VERSION = 1;

const version = z.literal(PROTOCOL_VERSION);

/* ------------------------------------------------------------------ *
 * Helper → App
 * ------------------------------------------------------------------ */

/**
 * Which insertion tier handled (or declined) a request. :
 *   ax      — AXUIElementSetAttributeValue on kAXSelectedTextAttribute.
 *             The only tier that genuinely reports success.
 *   unicode — CGEventKeyboardSetUnicodeString. Reports "sent", not "landed";
 *             it can half-succeed silently (§12.5).
 *   none    — neither worked. The clipboard is NOT touched (§5.8).
 */
export const INSERT_TIERS = ['ax', 'unicode', 'none'] as const;
export const InsertTierSchema = z.enum(INSERT_TIERS);
export type InsertTier = (typeof INSERT_TIERS)[number];

/**
 * `retry_insert` is `Ctrl+Cmd+V` — an in-memory re-run of the insertion ladder
 * against `lastTranscript`, never a clipboard paste.
 */
export const HOTKEY_ACTIONS = ['ptt_down', 'ptt_up', 'toggle', 'retry_insert'] as const;
export const HotkeyActionSchema = z.enum(HOTKEY_ACTIONS);
export type HotkeyAction = (typeof HOTKEY_ACTIONS)[number];

export const HELPER_CAPABILITIES = ['ax', 'unicode'] as const;
export type HelperCapability = (typeof HELPER_CAPABILITIES)[number];

export const ReadyFrameSchema = z.object({
  v: version,
  type: z.literal('ready'),
  version: z.string().min(1),
  /** Insertion tiers this build can actually attempt. */
  caps: z.array(z.enum(HELPER_CAPABILITIES)),
});

export const HotkeyFrameSchema = z.object({
  v: version,
  type: z.literal('hotkey'),
  action: HotkeyActionSchema,
  /** Milliseconds since the Unix epoch, from the helper's clock. Same machine,
   *  so no skew correction is needed; used to measure hold duration. */
  ts: z.number().int().nonnegative(),
});

export const SecureInputFrameSchema = z.object({
  v: version,
  type: z.literal('secure_input'),
  enabled: z.boolean(),
});

export const FrontmostFrameSchema = z.object({
  v: version,
  type: z.literal('frontmost'),
  /** `null` when no app owns the menu bar (rare, e.g. during login window). */
  bundleId: z.string().nullable(),
  name: z.string().nullable(),
  /**
   * Echoes the `id` of the `get_frontmost` this answers. Absent on unsolicited
   * pushes emitted when the frontmost app changes.
   *
   * NOTE — this field is an addition to the sketch in IMPLEMENTATION-PLAN.md
   * §3.1.2, which showed `frontmost` without an id while `get_frontmost`
   * carries one. Without the echo the app cannot correlate a reply, which
   *  (verify the target before inserting) requires. It is a
   * strict superset of the sketch: the unsolicited form is unchanged.
   */
  id: z.string().min(1).optional(),
});

/**
 * Why an insert was declined, in a form the app can branch on.
 *
 * **Added in Phase 5, and it fixes a real gap.** `error` is prose written for a
 * human, so the app had no way to tell "focus moved to another application"
 * apart from "neither tier worked" — and showed the wrong advice for the one
 * case  exists to handle, while
 * `NotInsertedReason.target_changed` sat in `contracts/events.ts` with nothing
 * anywhere able to produce it. That made the user-visible half of the
 * frontmost check missing even though the check itself worked.
 *
 *   target_changed — the frontmost app is no longer `targetBundleId` (§11.1.10)
 *   empty_text     — there was nothing to insert
 *   no_tier        — AX declined and Unicode injection failed
 *
 * Optional on the wire so an older helper binary still parses; absent means
 * "not stated", which the app treats as `no_tier`'s generic copy.
 */
export const INSERT_DECLINE_REASONS = ['target_changed', 'empty_text', 'no_tier'] as const;
export const InsertDeclineReasonSchema = z.enum(INSERT_DECLINE_REASONS);
export type InsertDeclineReason = (typeof INSERT_DECLINE_REASONS)[number];

export const InsertResultFrameSchema = z.object({
  v: version,
  type: z.literal('insert_result'),
  id: z.string().min(1),
  tier: InsertTierSchema,
  ok: z.boolean(),
  /** Real diagnostic text — e.g. the actual `AXError`. */
  error: z.string().nullable(),
  /** Absent on success, and absent from an older helper build. */
  reason: InsertDeclineReasonSchema.nullish(),
  /**
   * The application the ladder actually acted on.
   *
   * Added in Phase 5 together with the removal of the app-side frontmost check
   * (`contracts/state-machine.md` §11): the text now goes wherever the user is
   * pointing when the turn ends, so the app that was frontmost at press time is
   * no longer the app that received it, and a history row built from the
   * press-time value would name the wrong one.
   */
  frontmostBundleId: z.string().nullish(),
  frontmostName: z.string().nullish(),
});

/**
 * Whether the helper can actually do its job — emitted after the tap install is
 * attempted, and again whenever the answer changes.
 *
 * **Added in Phase 5.** Without it the tray said "Ready" while the event tap had failed to
 * install and `Fn` was dead: the product looked healthy and did nothing, which
 * is the exact failure the tray exists to prevent. The user hit it on the first
 * launch of the packaged app, where a fresh TCC identity means Accessibility
 * starts ungranted (docs/phase-2-report.md §4, HT-1).
 *
 * `ready` cannot carry this. Contract §2 requires `ready` to be the first frame
 * out, and the tap install happens after it — deliberately, so a tap failure is
 * reported rather than fatal.
 */
export const PermissionsFrameSchema = z.object({
  v: version,
  type: z.literal('permissions'),
  /** `AXIsProcessTrusted()`. Gates both the tap and the AX insertion tier. */
  accessibility: z.boolean(),
  /** Whether a `CGEventTap` is installed and enabled right now. The honest
   *  question, since Accessibility being granted does not by itself mean the
   *  tap survived (Secure Input blocks it system-wide, §4.6). */
  hotkeyActive: z.boolean(),
});

export const LogFrameSchema = z.object({
  v: version,
  type: z.literal('log'),
  level: z.enum(['info', 'warn', 'error']),
  msg: z.string(),
});

export const HelperToAppSchema = z.discriminatedUnion('type', [
  ReadyFrameSchema,
  HotkeyFrameSchema,
  SecureInputFrameSchema,
  FrontmostFrameSchema,
  InsertResultFrameSchema,
  PermissionsFrameSchema,
  LogFrameSchema,
]);

export type ReadyFrame = z.infer<typeof ReadyFrameSchema>;
export type HotkeyFrame = z.infer<typeof HotkeyFrameSchema>;
export type SecureInputFrame = z.infer<typeof SecureInputFrameSchema>;
export type FrontmostFrame = z.infer<typeof FrontmostFrameSchema>;
export type InsertResultFrame = z.infer<typeof InsertResultFrameSchema>;
export type PermissionsFrame = z.infer<typeof PermissionsFrameSchema>;
export type LogFrame = z.infer<typeof LogFrameSchema>;
export type HelperToApp = z.infer<typeof HelperToAppSchema>;

/* ------------------------------------------------------------------ *
 * App → Helper
 * ------------------------------------------------------------------ */

export const InsertCommandSchema = z.object({
  v: version,
  type: z.literal('insert'),
  id: z.string().min(1),
  text: z.string(),
  /**
   * The app the text is meant for, captured at `ptt_down`. The helper refuses
   * the insert if the frontmost app no longer matches.
   * `null` disables the check.
   */
  targetBundleId: z.string().nullable(),
});

export const CopyCommandSchema = z.object({
  v: version,
  type: z.literal('copy'),
  text: z.string(),
});

export const GetFrontmostCommandSchema = z.object({
  v: version,
  type: z.literal('get_frontmost'),
  id: z.string().min(1),
});

export const SetHotkeysCommandSchema = z.object({
  v: version,
  type: z.literal('set_hotkeys'),
  ptt: z.string().min(1),
  toggle: z.string().min(1),
  retry: z.string().min(1),
});

export const ShutdownCommandSchema = z.object({
  v: version,
  type: z.literal('shutdown'),
});

export const AppToHelperSchema = z.discriminatedUnion('type', [
  InsertCommandSchema,
  CopyCommandSchema,
  GetFrontmostCommandSchema,
  SetHotkeysCommandSchema,
  ShutdownCommandSchema,
]);

export type InsertCommand = z.infer<typeof InsertCommandSchema>;
export type CopyCommand = z.infer<typeof CopyCommandSchema>;
export type GetFrontmostCommand = z.infer<typeof GetFrontmostCommandSchema>;
export type SetHotkeysCommand = z.infer<typeof SetHotkeysCommandSchema>;
export type ShutdownCommand = z.infer<typeof ShutdownCommandSchema>;
export type AppToHelper = z.infer<typeof AppToHelperSchema>;

/* ------------------------------------------------------------------ *
 * Framing
 * ------------------------------------------------------------------ */

export type FrameParse<T> = { ok: true; frame: T } | { ok: false; reason: string; raw: string };

/**
 * Parse one line from the helper. Total by construction: a malformed frame is
 * a value, never an exception. IMPLEMENTATION-PLAN.md §3.2 — "Malformed input
 * must never crash the helper" — and the same must hold in this direction.
 */
export function parseHelperFrame(line: string): FrameParse<HelperToApp> {
  const trimmed = line.trim();
  if (trimmed.length === 0) return { ok: false, reason: 'empty line', raw: line };

  let json: unknown;
  try {
    json = JSON.parse(trimmed);
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : 'invalid JSON';
    return { ok: false, reason: `not JSON: ${detail}`, raw: trimmed };
  }

  const parsed = HelperToAppSchema.safeParse(json);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const where =
      issue === undefined ? '' : ` at ${issue.path.join('.') || '<root>'}: ${issue.message}`;
    return { ok: false, reason: `does not match the helper protocol${where}`, raw: trimmed };
  }
  return { ok: true, frame: parsed.data };
}

/** Parse a command in the app→helper direction. Used by the mock helper and tests. */
export function parseAppFrame(line: string): FrameParse<AppToHelper> {
  const trimmed = line.trim();
  if (trimmed.length === 0) return { ok: false, reason: 'empty line', raw: line };
  let json: unknown;
  try {
    json = JSON.parse(trimmed);
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : 'invalid JSON';
    return { ok: false, reason: `not JSON: ${detail}`, raw: trimmed };
  }
  const parsed = AppToHelperSchema.safeParse(json);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const where =
      issue === undefined ? '' : ` at ${issue.path.join('.') || '<root>'}: ${issue.message}`;
    return { ok: false, reason: `does not match the helper protocol${where}`, raw: trimmed };
  }
  return { ok: true, frame: parsed.data };
}

/**
 * Serialise a command as one NDJSON line, newline included.
 *
 * Transcripts routinely contain newlines; `JSON.stringify` escapes them to
 * `\n`, so a frame can never span lines. That is the property the whole framing
 * rests on.
 */
export function encodeAppFrame(command: AppToHelper): string {
  return `${JSON.stringify(command)}\n`;
}

export function encodeHelperFrame(frame: HelperToApp): string {
  return `${JSON.stringify(frame)}\n`;
}
