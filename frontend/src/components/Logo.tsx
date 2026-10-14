import { useId, type CSSProperties } from "react";

/**
 * The iReliabee mark: a speech bubble striped like a bee, with wings — help
 * that talks — leaving a stippled trail like the app's background patterns.
 *
 * Colours come from the theme (accent, on-accent, pattern dots), so the mark
 * re-colours with it. Pass `colors` for fixed renders (app icon, favicon).
 * `animated` plays the entrance used on the splash screen.
 */
export interface LogoColors { body: string; on: string; wing: string; trail: string; }

const THEMED: LogoColors = {
  body: "var(--primary)",
  on: "var(--on-primary)",
  wing: "rgba(var(--accent-rgb), 0.18)",
  trail: "rgb(var(--pattern-rgb))",
};

export default function Logo({ size = 24, colors = THEMED, animated = false, className = "", title }: {
  size?: number; colors?: LogoColors; animated?: boolean; className?: string; title?: string;
}) {
  const clip = `logo-${useId().replace(/[^a-zA-Z0-9-]/g, "")}`;
  const c = colors;
  const d = (s: number) => ({ animationDelay: `${s}s` }) as CSSProperties;
  return (
    <svg className={`logo ${animated ? "logo-animated" : ""} ${className}`} width={size} height={size} viewBox="0 0 64 64"
      role={title ? "img" : undefined} aria-hidden={title ? undefined : true} aria-label={title}>
      <defs>
        <clipPath id={clip}>
          <path d="M18 18H38A12 12 0 0 1 50 30V36A12 12 0 0 1 38 48H24L13 57V48H18A12 12 0 0 1 6 36V30A12 12 0 0 1 18 18Z" />
        </clipPath>
      </defs>
      {/* Trail: the bee's flight path, in stippled dots */}
      <g className="logo-trail">
        <circle cx="4" cy="60" r="1.6" fill={c.trail} style={d(0.9)} />
        <circle cx="8.2" cy="56.2" r="2.1" fill={c.trail} style={d(0.75)} />
        <circle cx="12.8" cy="52.6" r="2.6" fill={c.trail} style={d(0.6)} />
      </g>
      <g transform="translate(8 2) scale(0.875)">
        <g className="logo-wings">
          <ellipse cx="42" cy="12" rx="8" ry="5.5" transform="rotate(-25 42 12)" fill={c.wing} stroke={c.body} strokeWidth="2.2" />
          <ellipse cx="54" cy="15" rx="6.5" ry="4.5" transform="rotate(20 54 15)" fill={c.wing} stroke={c.body} strokeWidth="2.2" />
        </g>
        <g className="logo-body" clipPath={`url(#${clip})`}>
          <rect width="64" height="64" fill={c.body} />
          {/* Tinted, not cut out, so the bubble keeps one clear silhouette at every size. */}
          <rect x="20" y="10" width="5.5" height="50" fill={c.on} opacity="0.5" />
          <rect x="32" y="10" width="5.5" height="50" fill={c.on} opacity="0.5" />
        </g>
      </g>
    </svg>
  );
}

/** Fixed colours for places the theme can't reach: the app icon and favicon. */
export const ICON_COLORS: LogoColors = { body: "#0f2a30", on: "#f7f7f2", wing: "#dbdedb", trail: "#e28046" };  // wing = 12% teal on off-white
