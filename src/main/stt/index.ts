/**
 * OWNER: **Phase 3**. The STT seam.
 *
 * `src/main/index.ts` calls `createSttClient(logger)` and nothing else, so this
 * file is the only place that knows the real client needs an auth provider. The
 * Phase 1 mock (`mocks/mock-stt.ts`) is no longer used by the app; it stays as
 * the test double the Phase 1 round-trip test is built on.
 *
 * Read `docs/spike-results.md` before changing anything behind here — §1 deleted
 * a whole subsystem, §2 chose the end-of-turn message, §4 showed a long hold
 * yields many finals, and §5 covers keyterms.
 */

import type { AuthPort, SttClientPort } from '@contracts/ports.js';
import type { Logger } from '@shared/logger.js';
import { XaiSttClient } from './client.js';

export { XaiSttClient } from './client.js';
export type { SttClientOptions } from './client.js';

export function createSttClient(logger: Logger, auth: AuthPort): SttClientPort {
  return new XaiSttClient({ auth, logger });
}
