#!/usr/bin/env node
/**
 * Mock Swift helper — Phase 1 walking skeleton.
 *
 * Speaks the *real* protocol from `contracts/helper-protocol.md` over stdin and
 * stdout, so the app's parsing, framing, correlation and supervision paths are
 * all exercised for real. Phase 2 replaces this process with the Swift binary
 * and nothing on the app side changes (IMPLEMENTATION-PLAN.md §3.1.3).
 *
 * This file is owned by Phase 1 (`mocks/`). Phase 2 deletes it when the real
 * helper lands.
 *
 * Beyond the contract it understands one extra frame, `__mock`, which is how
 * the debug window makes it emit hotkey and secure-input frames. That is
 * deliberately namespaced with a double underscore and is the ONLY extension —
 * everything the app itself sends and receives is exactly the real protocol.
 *
 * Plain JS on purpose: it must run as a standalone child process with no build
 * step, exactly as the Swift binary will.
 */

const PROTOCOL_VERSION = 1;
const VERSION = '0.1.0-mock';

/** What the next `insert` should report. Driven by `__mock.setInsertOutcome`. */
let insertOutcome = { tier: 'ax', ok: true, error: null };

/** Simulated frontmost application. */
let frontmost = { bundleId: 'com.apple.TextEdit', name: 'TextEdit' };

/** Every insert seen this run — the "no clipboard write" assertion reads this. */
const clipboardWrites = [];

function send(frame) {
  process.stdout.write(`${JSON.stringify({ v: PROTOCOL_VERSION, ...frame })}\n`);
}

function log(level, msg) {
  send({ type: 'log', level, msg });
}

function handle(line) {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    // Contract §1 rule 1: a malformed line is logged and skipped, never fatal.
    log('warn', 'ignoring unparseable line');
    return;
  }
  if (typeof message !== 'object' || message === null) {
    log('warn', 'ignoring non-object frame');
    return;
  }

  switch (message.type) {
    case 'insert': {
      // Contract §3: honour the target check. A mismatch declines rather than
      // typing into whatever happens to be in front now.
      if (
        typeof message.targetBundleId === 'string' &&
        message.targetBundleId !== frontmost.bundleId
      ) {
        send({
          type: 'insert_result',
          id: message.id,
          tier: 'none',
          ok: false,
          error: `frontmost app is ${frontmost.bundleId ?? 'unknown'}, expected ${message.targetBundleId}`,
          reason: 'target_changed',
          frontmostBundleId: frontmost.bundleId,
          frontmostName: frontmost.name,
        });
        return;
      }
      // NOTE: no pasteboard write here, and there is no code path in this file
      // that writes the pasteboard on an insert. That is the hard product
      // requirement from , asserted by the app's tests.
      send({
        type: 'insert_result',
        id: message.id,
        tier: insertOutcome.tier,
        ok: insertOutcome.ok,
        error: insertOutcome.error,
        reason: insertOutcome.ok ? null : 'no_tier',
        frontmostBundleId: frontmost.bundleId,
        frontmostName: frontmost.name,
      });
      return;
    }

    case 'copy':
      // The ONLY pasteboard path, and only ever reached from an explicit user
      // click in the HUD or history.
      clipboardWrites.push(message.text);
      log('info', `copy requested (${String(clipboardWrites.length)} this session)`);
      return;

    case 'get_frontmost':
      send({
        type: 'frontmost',
        bundleId: frontmost.bundleId,
        name: frontmost.name,
        id: message.id,
      });
      return;

    case 'set_hotkeys':
      log(
        'info',
        `hotkeys set: ptt=${message.ptt} toggle=${message.toggle} retry=${message.retry}`,
      );
      return;

    case 'shutdown':
      log('info', 'shutting down');
      process.exit(0);
      return;

    /* ---- mock-only control channel (see the header) ---- */
    case '__mock': {
      switch (message.action) {
        case 'hotkey':
          send({ type: 'hotkey', action: message.hotkeyAction, ts: Date.now() });
          return;
        case 'secure_input':
          send({ type: 'secure_input', enabled: Boolean(message.enabled) });
          return;
        case 'frontmost':
          frontmost = { bundleId: message.bundleId ?? null, name: message.name ?? null };
          send({ type: 'frontmost', bundleId: frontmost.bundleId, name: frontmost.name });
          return;
        case 'set_insert_outcome':
          insertOutcome = {
            tier: message.tier ?? 'ax',
            ok: Boolean(message.ok),
            error: message.error ?? null,
          };
          log('info', `insert outcome set to ${insertOutcome.tier}/${String(insertOutcome.ok)}`);
          return;
        case 'crash':
          // Used to prove the supervisor restarts a dead helper.
          process.exit(7);
          return;
        case 'garbage':
          // Emit frames the app must survive: bad JSON, wrong version, unknown
          // type, unknown field on a known type (contract §1 rules 1-3).
          process.stdout.write('this is not json\n');
          process.stdout.write(
            `${JSON.stringify({ v: 99, type: 'ready', version: 'x', caps: [] })}\n`,
          );
          process.stdout.write(
            `${JSON.stringify({ v: 1, type: 'from_the_future', payload: 1 })}\n`,
          );
          process.stdout.write(
            `${JSON.stringify({ v: 1, type: 'secure_input', enabled: false, extraField: 'ignore me' })}\n`,
          );
          return;
        default:
          log('warn', `unknown __mock action: ${String(message.action)}`);
          return;
      }
    }

    default:
      // Contract §1 rule 2: unknown types degrade, they do not kill the helper.
      log('warn', `unknown command type: ${String(message.type)}`);
  }
}

let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  const parts = buffer.split('\n');
  buffer = parts.pop() ?? '';
  for (const line of parts) {
    const trimmed = line.trim();
    if (trimmed.length > 0) handle(trimmed);
  }
});
process.stdin.on('end', () => process.exit(0));

// The first frame, per contract §2.
send({ type: 'ready', version: VERSION, caps: ['ax', 'unicode'] });
// …followed by the initial Secure Input value.
send({ type: 'secure_input', enabled: false });
// Contract §2: emitted once the tap install has been attempted. This mock has
// no tap, and reports the healthy answer so the skeleton is not permanently
// warning about a permission it does not need.
send({ type: 'permissions', accessibility: true, hotkeyActive: true });
