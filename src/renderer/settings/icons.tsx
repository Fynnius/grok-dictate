/**
 * OWNER: Design overhaul 2026-08-09 (session 2). Every glyph the panels use,
 * as inline SVG.
 *
 * Drawn on Lucide's grid — 24 × 24 viewBox, 2 px stroke, round caps and
 * joins, `currentColor` — so they read as the same family shadcn's own
 * screenshots use, without an icon package: the whole product needs a handful
 * of glyphs, and a dependency for that is the reflex this project avoids
 *.
 */

interface IconProps {
  /** Rendered size in px. The stroke scales with it. */
  readonly size?: number;
}

function svgProps(size: number): React.SVGProps<SVGSVGElement> {
  return {
    width: size,
    height: size,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 2,
    strokeLinecap: 'round',
    strokeLinejoin: 'round',
    'aria-hidden': true,
  };
}

export function SearchIcon({ size = 14 }: IconProps): React.JSX.Element {
  return (
    <svg {...svgProps(size)}>
      <circle cx="11" cy="11" r="8" />
      <path d="m21 21-4.35-4.35" />
    </svg>
  );
}

export function XIcon({ size = 14 }: IconProps): React.JSX.Element {
  return (
    <svg {...svgProps(size)}>
      <path d="M18 6 6 18" />
      <path d="m6 6 12 12" />
    </svg>
  );
}

export function CopyIcon({ size = 14 }: IconProps): React.JSX.Element {
  return (
    <svg {...svgProps(size)}>
      <rect x="9" y="9" width="13" height="13" rx="2" />
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
    </svg>
  );
}

export function CheckIcon({ size = 14 }: IconProps): React.JSX.Element {
  return (
    <svg {...svgProps(size)}>
      <path d="M20 6 9 17l-5-5" />
    </svg>
  );
}

export function TrashIcon({ size = 14 }: IconProps): React.JSX.Element {
  return (
    <svg {...svgProps(size)}>
      <path d="M3 6h18" />
      <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />
      <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
      <path d="M10 11v6" />
      <path d="M14 11v6" />
    </svg>
  );
}

export function InfoIcon({ size = 14 }: IconProps): React.JSX.Element {
  return (
    <svg {...svgProps(size)}>
      <circle cx="12" cy="12" r="10" />
      <path d="M12 16v-4" />
      <path d="M12 8h.01" />
    </svg>
  );
}
