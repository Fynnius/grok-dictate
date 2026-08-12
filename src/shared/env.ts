/**
 * The single sanctioned reader of `process.env`.
 *
 * ESLint bans `process.env` everywhere else (see `eslint.config.js`): the
 * environment is a common accidental route for a bearer token into a log, and
 * funnelling access through one module makes every read greppable.
 */

/* eslint-disable no-restricted-syntax */

export function envString(name: string): string | undefined {
  const value = process.env[name];
  return value === undefined || value === '' ? undefined : value;
}

export function envFlag(name: string): boolean {
  const value = envString(name);
  return value === '1' || value?.toLowerCase() === 'true';
}

/**
 * The environment to hand a child process: the parent's, plus overrides.
 *
 * Lives here because `env.ts` is the only sanctioned reader of `process.env`
 * (see the header). Nothing in the returned object is ever logged — the helper
 * supervisor logs the command and args, never the environment.
 */
export function childEnv(overrides: Readonly<Record<string, string>>): NodeJS.ProcessEnv {
  return { ...process.env, ...overrides };
}

/** electron-vite injects this in dev; absent in a packaged build. */
export function rendererDevServerUrl(): string | undefined {
  return envString('ELECTRON_RENDERER_URL');
}

/**
 * POSIX locale precedence, as `language.rs:192-201` in the Grok source resolves
 * it: `LC_ALL`, then `LC_MESSAGES`, then `LANG`; set-but-empty counts as unset
 * and `C`/`POSIX` are ignored. Only the primary subtag is meaningful.
 *
 * Kept in Phase 1 because  shows this is *all* Grok's `auto`
 * language setting ever did — it is the fallback for the app's own language
 * mode, not a detector.
 */
export function systemLanguageSubtag(): string | undefined {
  for (const name of ['LC_ALL', 'LC_MESSAGES', 'LANG']) {
    const raw = envString(name);
    if (raw === undefined) continue;
    if (raw === 'C' || raw === 'POSIX') continue;
    const primary = raw.split('.')[0]?.split('_')[0]?.split('-')[0]?.toLowerCase();
    if (primary !== undefined && primary.length > 0) return primary;
  }
  return undefined;
}
