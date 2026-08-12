/**
 * OWNER: Design overhaul 2026-08-09 (session 2). The panel shell every window
 * renders into, plus the small controls the panels share.
 *
 * The shell is the structural fix for the transparent-band bug: a grid of
 * non-scrolling header / optional toolbar / scrolling body /
 * optional footer, where **only the body scrolls**. The header doubles as the
 * window's drag region and reserves the traffic-light
 * inset, so nothing can ever scroll above or below the chrome again.
 */

import { InfoIcon } from './icons.js';

interface PanelShellProps {
  readonly title: string;
  /** Rendered at the right end of the title row (a chip, a counter). */
  readonly accessory?: React.ReactNode;
  /** A non-scrolling row between header and body (History's search). */
  readonly toolbar?: React.ReactNode;
  readonly footer?: React.ReactNode;
  readonly className?: string;
  readonly children: React.ReactNode;
}

export function PanelShell({
  title,
  accessory,
  toolbar,
  footer,
  className,
  children,
}: PanelShellProps): React.JSX.Element {
  return (
    <main className={className === undefined ? 'panel' : `panel ${className}`}>
      <header className="panel-head">
        <h1>{title}</h1>
        <span className="spacer" />
        {accessory}
      </header>
      {toolbar === undefined ? <div /> : <div className="panel-toolbar">{toolbar}</div>}
      <div className="panel-body">{children}</div>
      {footer === undefined ? null : <footer className="panel-foot">{footer}</footer>}
    </main>
  );
}

/**
 * A drawn NSSwitch-shaped toggle. The real checkbox stays in the tree —
 * invisible but focusable — so keyboard and assistive access are the native
 * input's, not a reimplementation.
 */
export function Switch({
  checked,
  onChange,
  ariaLabel,
}: {
  readonly checked: boolean;
  readonly onChange: (next: boolean) => void;
  readonly ariaLabel: string;
}): React.JSX.Element {
  return (
    <span className="switch">
      <input
        type="checkbox"
        role="switch"
        aria-label={ariaLabel}
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
      />
      <span className="track" />
    </span>
  );
}

/**
 * The ⓘ disclosure that holds a setting's explanatory prose. The notes are
 * genuinely valuable — they exist because several settings do less than their
 * names suggest (spikes 2 and 3) — but as body copy under every control they
 * made the pane read as documentation. Hover or keyboard
 * focus reveals the text; the positioning is pure CSS.
 */
export function InfoTip({ text }: { readonly text: string }): React.JSX.Element {
  return (
    <span className="infotip">
      <button type="button" aria-label="More about this setting">
        <InfoIcon />
      </button>
      <span className="tip" role="note">
        {text}
      </span>
    </span>
  );
}

/**
 * A macOS-style segmented control for a small exclusive set — what the old
 * pane rendered as loose web radios.
 */
export function Segmented<T extends string>({
  options,
  value,
  onChange,
  ariaLabel,
}: {
  readonly options: readonly (readonly [T, string])[];
  readonly value: T;
  readonly onChange: (next: T) => void;
  readonly ariaLabel: string;
}): React.JSX.Element {
  return (
    <div className="segmented" role="radiogroup" aria-label={ariaLabel}>
      {options.map(([key, label]) => (
        <button
          key={key}
          type="button"
          role="radio"
          aria-checked={value === key}
          className={value === key ? 'on' : ''}
          onClick={() => onChange(key)}
        >
          {label}
        </button>
      ))}
    </div>
  );
}
