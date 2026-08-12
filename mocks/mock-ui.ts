/**
 * In-memory doubles for the UI-side ports — Phase 1.
 *
 * These exist so the whole dictation round-trip can run under Vitest with no
 * Electron, no window server and no filesystem. Phase 4 owns the real
 * implementations; these stay as test doubles.
 */

import type { AppConfig } from '@contracts/config.js';
import { DEFAULT_CONFIG } from '@contracts/config.js';
import type { HistoryEntry, HudView, SessionState } from '@contracts/events.js';
import type {
  AudioCue,
  ConfigPort,
  HistoryPort,
  HudPort,
  SoundPort,
  TrayPort,
} from '@contracts/ports.js';

export class MemoryHud implements HudPort {
  readonly views: HudView[] = [];
  show(view: HudView): void {
    this.views.push(view);
  }
  hide(): void {
    this.views.push({ kind: 'hidden' });
  }
  get last(): HudView | undefined {
    return this.views.at(-1);
  }
}

export class MemoryTray implements TrayPort {
  readonly states: { state: SessionState; secureInput: boolean }[] = [];
  setState(state: SessionState, secureInput: boolean): void {
    this.states.push({ state, secureInput });
  }
}

export class MemorySound implements SoundPort {
  readonly cues: AudioCue[] = [];
  play(cue: AudioCue): void {
    this.cues.push(cue);
  }
}

export class MemoryHistory implements HistoryPort {
  readonly entries: HistoryEntry[] = [];
  append(entry: HistoryEntry): Promise<void> {
    this.entries.push(entry);
    return Promise.resolve();
  }
  list(query: string | null, limit: number): Promise<readonly HistoryEntry[]> {
    const needle = query?.toLowerCase() ?? null;
    const matched =
      needle === null
        ? this.entries
        : this.entries.filter((e) => e.text.toLowerCase().includes(needle));
    return Promise.resolve([...matched].reverse().slice(0, limit));
  }
  purge(): Promise<void> {
    this.entries.length = 0;
    return Promise.resolve();
  }
  count(): Promise<number> {
    return Promise.resolve(this.entries.length);
  }
}

export class MemoryConfig implements ConfigPort {
  #config: AppConfig;
  readonly #listeners = new Set<(config: AppConfig) => void>();

  constructor(config: Partial<AppConfig> = {}) {
    this.#config = { ...DEFAULT_CONFIG, ...config };
  }
  get(): AppConfig {
    return this.#config;
  }
  set(config: AppConfig): Promise<void> {
    this.#config = config;
    for (const l of this.#listeners) l(config);
    return Promise.resolve();
  }
  onChange(listener: (config: AppConfig) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }
}
