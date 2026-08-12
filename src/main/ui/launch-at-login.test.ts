import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG } from '@contracts/config.js';
import { createLogger } from '@shared/logger.js';
import { syncLaunchAtLogin, type LoginItemTarget } from './launch-at-login.js';

const log = createLogger('test');

class FakeLoginItems implements LoginItemTarget {
  openAtLogin = false;
  writes = 0;
  throwOnRead = false;
  throwOnWrite = false;

  getLoginItemSettings(): { openAtLogin: boolean } {
    if (this.throwOnRead) throw new Error('LaunchServices unavailable');
    return { openAtLogin: this.openAtLogin };
  }
  setLoginItemSettings(settings: { openAtLogin: boolean }): void {
    if (this.throwOnWrite) throw new Error('LaunchServices refused');
    this.writes += 1;
    this.openAtLogin = settings.openAtLogin;
  }
}

describe('syncLaunchAtLogin', () => {
  it('registers when the user has turned it on', () => {
    const target = new FakeLoginItems();
    expect(syncLaunchAtLogin(target, { ...DEFAULT_CONFIG, launchAtLogin: true }, log)).toBe(true);
    expect(target.openAtLogin).toBe(true);
  });

  it('writes nothing when the OS already agrees', () => {
    const target = new FakeLoginItems();
    target.openAtLogin = true;
    expect(syncLaunchAtLogin(target, { ...DEFAULT_CONFIG, launchAtLogin: true }, log)).toBe(false);
    expect(target.writes).toBe(0);
  });

  it('re-asserts the setting when the OS has drifted away from it', () => {
    // The user can remove the app in System Settings without telling the app.
    const target = new FakeLoginItems();
    target.openAtLogin = true;
    expect(syncLaunchAtLogin(target, { ...DEFAULT_CONFIG, launchAtLogin: false }, log)).toBe(true);
    expect(target.openAtLogin).toBe(false);
  });

  it('never lets a LaunchServices failure stop the app', () => {
    const readFails = new FakeLoginItems();
    readFails.throwOnRead = true;
    expect(() =>
      syncLaunchAtLogin(readFails, { ...DEFAULT_CONFIG, launchAtLogin: true }, log),
    ).not.toThrow();

    const writeFails = new FakeLoginItems();
    writeFails.throwOnWrite = true;
    expect(syncLaunchAtLogin(writeFails, { ...DEFAULT_CONFIG, launchAtLogin: true }, log)).toBe(
      false,
    );
  });
});
