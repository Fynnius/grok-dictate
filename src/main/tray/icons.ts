/**
 * OWNER: **Phase 4**. Menu-bar template icons, embedded as base64 PNGs.
 *
 * Why embedded rather than files on disk: `electron.vite.config.ts` is a Phase 1
 * file and frozen (IMPLEMENTATION-PLAN.md §2), so Phase 4 cannot add an asset
 * pipeline or a `build.extraResources` entry. These are a few hundred bytes
 * each, and inlining them means the tray works identically in `npm run dev` and
 * in a packaged build with no extra wiring.
 *
 * They are **template images**: black pixels carrying all their information in
 * the alpha channel. macOS recolours them for the light and dark menu bar and
 * inverts them while the menu is open, which is why they must not be coloured —
 * a red "recording" icon would be illegible on a dark menu bar and would fight
 * the system highlight.
 *
 * Each was rendered from signed-distance functions with 4x4 supersampling at
 * 16px (1x) and 32px (2x) and PNG-encoded with `node:zlib`. The generator is
 * reproduced in docs/phase-4-report.md §"Tray icons" so the glyphs can be
 * regenerated or adjusted without reverse-engineering the base64.
 *
 * The three states are the ones  asks the tray to surface:
 * idle, recording, and **blocked** — the last being Secure Input, one of the two
 * silent failures §12.2 warns "will make a working app look broken".
 */

export type TrayIconName = 'idle' | 'recording' | 'blocked';

export interface TrayIconData {
  /** 16x16, for a standard-density display. */
  readonly x1: string;
  /** 32x32, the Retina representation. */
  readonly x2: string;
}

export const TRAY_ICON_PNG_BASE64: Record<TrayIconName, TrayIconData> = {
  idle: {
    x1:
      'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAvklEQVR42s3SMQrCMBTG8SoGtJsHaBfP4dSpky7d' +
      'epFC5y5dCh3bC4gg3XRw8gyCFCFexW/4DyIYIjj44Afhe+kLpAkCd03wdc0klQ4pmXdtxcoOlsyrjOw5eYGOzPgM' +
      'COUsxUtWkIX/P2AjmWNAxp6PVclJBmm5NMN6oFe5BiT8sloefNiyruklrgFzaeQmvRzRkzXscdZSSrlyomVd0vN6' +
      'SGvJ5YCczOshRXKRUe4YySKfAVOJZfUmpvfbegIEGjEp5Prl9AAAAABJRU5ErkJggg==',
    x2:
      'iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAABvElEQVR42u2Wv0sCYRjHTcShmoRAriFcamzJECdb' +
      'GhvCZgf3hlpaoil0kKaGppbWhggKaupvaEoUhKhIcBAqRFLfvgef4JAj9H4MwX3hA+89z/d93ve8u+c1FovkTfMi' +
      'K3YgSyx0zYi8uBYd8Q0dYnk8oakgGsKIkfiEEbEGnlC0IB5YqCtqLFZg3CX3gDdwbYmeGIhDkXTkksQGeLbC2MAR' +
      'd/giVlzyK+QM3sBVo3hdWC55i5zBG20g2kC0Ad9aE3fiXuQ8bCDH3DtqTa112qvd58vimOItkXHxZ8gZvGXmdqk1' +
      'tRbFEwUvRImTr0/xuMMbJ9bHU2KOocailw0kxDlF3kRRPHL9zIIZKBMzeIrMMdRIeH0PNjjr7UI3Ytdx3ecnbzE2' +
      '5Hbx/l5v+HkR7VPuhFNuKK7EAXf5zSKG8SO5K7wD5ib9fg1pcUlRe7GmOBVVcQZVYk08Q+akg+oBFgt9OO76S7zD' +
      'lyP+gdcKuhHNim1xK9ouj6BNbhtvaJoTq2KPfz89xqvkQpH9nW+KfQcVxwYqY7nNsT7hW0uONjsJdeYEphSf1ysN' +
      '5i9e8aaCfgx2weUJScUi/Rf9AFhqx1HqiXJaAAAAAElFTkSuQmCC',
  },
  recording: {
    x1:
      'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAtklEQVR42tXTsQqCUBjFcckE1x5Al4ZeoMYmHyCH' +
      'O/oMgbtTQ3NP0uzcMwSigYPD3X2C+g9nkEC9QQ0d+MHl+7xHEPS8H8ZHLP6nl5fI0UiumXM26PCUTjPn7NAPCnrN' +
      '/qDggHSiINUzozmjxBZ2UGA1K/XMaBK0MDjpotXZaJdMFYS4oMJRl4zOlXbh3HdYocBdb2x1LrSbTYA9Mlwl0yxw' +
      'KYhwQ42H1JpFLgUL/UDrN7F2380LEuo3KSwNCSkAAAAASUVORK5CYII=',
    x2:
      'iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAABiElEQVR42u3WsUsCURwH8DPTQQnhJjmDpqIGaQlx' +
      'FczBrZbm6D+w2dkm5yaX1qCWBNv8F5wS5DatQCQQ7dBO+x58hcdRj7reC4T7wQfkvd/v9369wzPDCGONIwX7lPrP' +
      'g+NwBm14pjbX4roPj8A5jGDpM+JeROcA29D54vCVDnO0xTFMJQNMmaMtTmAmGWDGnHCAcIBwACVxBC14hHyAAfKs' +
      'bbHXryMHb7CAC66VwZEM4DDHYM2CPXJBBsjAExvfQAx2wZYMYDMnxpole2SCDLAJDTYZ8EqjUP3mFhzuRZk74HqD' +
      'vQJFAYZs9AAWbPEgm4c6/FzlnsXcJWsLf/3tr8MHuHAHWeFxlGl17VnmuKypq/gfIQ23bOr9VT24giIcUJFrPea4' +
      'rEmr+kp613oNY+GZT+CFJsL6mLmW6pdQAk6hCa8wFw6dc63JnITOt2ESDqEC71ThWlLXoRtQgktBTRig5tsrsUZZ' +
      '7EBX8gLy67JGWZhwD32+YGT6zDVVPwav4d4PmUYY6xKfMNTax/haldsAAAAASUVORK5CYII=',
  },
  blocked: {
    x1:
      'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAA8ElEQVR42mNgoCFgBmI5KGZGE2cmpJkFiAuB+BYU' +
      'F0LFeIC4CYhrCBmiDsSPgPg/FJ8FYnkg7gTi91BD8BpgCsQfoZqfAnE8EHdBNXdCXcJAjAEgzYlA3E2KZpgB18nR' +
      '7A/EAUCsBcQRSJpBtChUzh+fAW1AvBKIJdA0B0IN3QFVgxNYAXEYUoDBNOcAcQgQ3wNiZ3wG8CNpBtEaQOwJxHnQ' +
      'MJkAxBy4NPMgxTNIsx8Qn4TaegWaeATxJdsmJM06UK+sg+IYILYFYlZ8BtRADZEG4g1AfBOIb0MxiH0IiGUJZR4Q' +
      'ZoJmIGU0LAeVoy4AAIiKOhoUIPJaAAAAAElFTkSuQmCC',
    x2:
      'iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAABxElEQVR42u3WuUsDQRgF8MQjEQ9yaOGFVooWagQJ' +
      'aQW118ZaxPwBsbY1VlYprNJYBQQFUYhd1MbWKoJtPECCICpeiW/gLQxhr2R2V4R88IMwmez72NnMjs/XrH9cIZig' +
      'kJfBAViFAtxTgWMBnflhSJJyo35YgzJUa5T5nV+aH4EMfFBStYFhuNYJ14jvBnTCq041sAhvJg1cQJ9BeIbLoVTL' +
      '8GkQfgUxk/CIEw+gUQMifNbtcKMGPAvXa8DT8NoGPA+XG/iTcK2BS6/C5yAPZ5DgWBxmLMKDnJvgb/O8Vt0lwp6h' +
      'AuscC1qET3Ev8PE3FV4j3kgDQ1BkyDb3eLNwsSw5GIN22OecIq9Vd7VBlg/ctI1w8Ubcglbe/jvOy/JaDVWMt9Xq' +
      'tucY3gODcMJ5TzCv+vq1euBi0m0XzRzCD3zDrsEZwXaZhffCOEzCAuzALeeJBg6g361wsebn8ECv0vb8AntcClfC' +
      'R7jGX1Ko+PwIp7ACnSrhYYsdroObUQreKcWxLid2wKRBuDhqbcAmpaUG0tK4sAQtqg3I4d1wbHIUq3UDoyrnfe0Y' +
      'HZaW5QhK3GDMlDg36vSbMMq/nR2OhzfLtfoFFy3mo99Wv1YAAAAASUVORK5CYII=',
  },
};

/** `data:` URL form, which is what `nativeImage.createFromDataURL` wants. */
export function trayIconDataUrl(base64: string): string {
  return `data:image/png;base64,${base64}`;
}
