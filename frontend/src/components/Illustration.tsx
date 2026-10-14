/**
 * Animated line-and-stipple illustrations for empty and waiting states.
 * Every colour comes from the theme (accent, ink, pattern dots), so they
 * re-colour with it; motion is slow and looping, and stops entirely for
 * people who ask for reduced motion (see .illo in index.css).
 */
import type { CSSProperties, ReactNode } from "react";

export type IllustrationName =
  | "listen" | "coach" | "plan" | "people" | "research" | "library" | "progress"
  | "explain" | "stories" | "chat" | "notes" | "score" | "welcome" | "calendar";

/** A soft oval of stippled dots behind each scene; a few of them twinkle. */
function Backdrop({ seed, cx = 100, cy = 70, rx = 84, ry = 52, n = 70 }: {
  seed: number; cx?: number; cy?: number; rx?: number; ry?: number; n?: number;
}) {
  let s = seed;
  const rand = () => ((s = (s * 16807) % 2147483647) / 2147483647);
  const dots: ReactNode[] = [];
  for (let i = 0; i < n; i++) {
    const a = rand() * Math.PI * 2;
    const d = Math.sqrt(rand());  // uniform over the oval
    const x = cx + Math.cos(a) * rx * d;
    const y = cy + Math.sin(a) * ry * d;
    const r = 0.8 + (1 - d) * 1.6;
    const twinkle = i % 9 === 0;
    dots.push(
      <circle key={i} cx={x.toFixed(1)} cy={y.toFixed(1)} r={r.toFixed(2)}
        className={twinkle ? "dot illo-twinkle" : "dot"}
        style={{ opacity: 0.18 + (1 - d) * 0.45, ...(twinkle ? { animationDelay: `${(i % 5) * 0.6}s` } : {}) } as CSSProperties} />,
    );
  }
  return <g className="illo-backdrop">{dots}</g>;
}

const delay = (s: number) => ({ animationDelay: `${s}s` }) as CSSProperties;

function arcDots(cx: number, cy: number, r: number, from: number, to: number, count: number) {
  return Array.from({ length: count }, (_, i) => {
    const a = ((from + ((to - from) * i) / (count - 1)) * Math.PI) / 180;
    return [cx + Math.cos(a) * r, cy + Math.sin(a) * r] as const;
  });
}

const SCENES: Record<IllustrationName, () => ReactNode> = {
  listen: () => (
    <>
      <Backdrop seed={11} />
      {[0, 1, 2].map(i => (
        <g key={i} className="illo-pulse" style={delay(i * 0.35)}>
          {[...arcDots(100, 58, 34 + i * 13, -38, 38, 5), ...arcDots(100, 58, 34 + i * 13, 142, 218, 5)].map(([x, y], j) => (
            <circle key={j} cx={x} cy={y} r={2.2 - i * 0.4} className="fill-accent" />
          ))}
        </g>
      ))}
      <g className="illo-float">
        <rect x="88" y="30" width="24" height="44" rx="12" className="soft stroke-accent" />
        <path d="M94 44h12M94 51h12M94 58h12" className="stroke-ink" />
        <path d="M78 62a22 22 0 0 0 44 0M100 84v14M88 98h24" className="line stroke-accent" />
      </g>
    </>
  ),
  coach: () => (
    <>
      <Backdrop seed={23} />
      <g className="illo-float">
        <path d="M58 40h84a16 16 0 0 1 16 16v26a16 16 0 0 1-16 16H92l-16 14v-14H58a16 16 0 0 1-16-16V56a16 16 0 0 1 16-16z" className="soft stroke-accent" />
        {[80, 100, 120].map((x, i) => <circle key={x} cx={x} cy="69" r="5" className="fill-accent illo-bounce" style={delay(i * 0.18)} />)}
      </g>
      <path d="M160 24l3 8 8 3-8 3-3 8-3-8-8-3 8-3z" className="fill-accent illo-twinkle" />
      <circle cx="146" cy="18" r="2.4" className="dot illo-twinkle" style={delay(0.8)} />
    </>
  ),
  plan: () => (
    <>
      <Backdrop seed={37} cy={74} />
      <path d="M34 108C60 108 58 74 90 76S126 46 150 42" className="line stroke-ink dotted" />
      <path d="M34 108C60 108 58 74 90 76S126 46 150 42" className="line stroke-accent illo-draw" pathLength={100} />
      {[[62, 94], [90, 76], [121, 55]].map(([x, y], i) => (
        <circle key={i} cx={x} cy={y} r="4" className="soft-solid stroke-accent illo-pop" style={delay(0.6 + i * 0.5)} />
      ))}
      <circle cx="34" cy="108" r="6" className="fill-accent" />
      <path d="M150 44V14" className="line stroke-accent" />
      <path d="M150 14l24 6-24 8z" className="fill-accent illo-flag" />
    </>
  ),
  calendar: () => (
    <>
      <Backdrop seed={61} />
      <g className="illo-float">
        <rect x="46" y="30" width="88" height="76" rx="10" className="soft stroke-accent" />
        <path d="M46 48h88" className="line stroke-accent" />
        <path d="M68 22v14M112 22v14" className="line thick stroke-accent" />
        {[62, 76, 90].flatMap((y, r) => [62, 76, 90, 104, 118].map((x, c) => (
          r === 1 && c === 2 ? null : <circle key={`${x}-${y}`} cx={x} cy={y} r="2.2" className="dot" />
        )))}
        <circle cx="90" cy="76" r="8" className="soft-solid stroke-accent illo-pop" style={delay(0.4)} />
        <circle cx="90" cy="76" r="2.8" className="fill-accent" />
      </g>
      <g>
        <circle cx="152" cy="98" r="16" className="soft-solid stroke-accent" />
        {/* Rotates about the clock's centre in drawing coordinates, not the hand's own box. */}
        <path d="M152 98v-10" className="line stroke-accent" style={{ transformBox: "view-box", transformOrigin: "0 0" }}>
          <animateTransform attributeName="transform" type="rotate" from="0 152 98" to="360 152 98" dur="8s" repeatCount="indefinite" />
        </path>
        <path d="M152 98h7" className="line stroke-ink" />
        <circle cx="152" cy="98" r="2" className="fill-accent" />
      </g>
    </>
  ),
  people: () => (
    <>
      <Backdrop seed={41} />
      {[64, 136].map((x, i) => (
        <g key={x} className="illo-float" style={delay(i * 0.9)}>
          <circle cx={x} cy="56" r="12" className="soft stroke-accent" />
          <path d={`M${x - 21} 96a21 19 0 0 1 42 0`} className="soft stroke-accent" />
        </g>
      ))}
      <path id="illo-link" d="M82 58Q100 36 118 58" className="line stroke-ink dotted" />
      <circle r="3.4" className="fill-accent">
        <animateMotion dur="2.6s" repeatCount="indefinite" path="M82 58Q100 36 118 58" keyPoints="0;1;0" keyTimes="0;0.5;1" calcMode="linear" />
      </circle>
      <path d="M100 22l2 5 5 2-5 2-2 5-2-5-5-2 5-2z" className="fill-accent illo-twinkle" />
    </>
  ),
  research: () => (
    <>
      <Backdrop seed={53} n={110} rx={90} ry={56} />
      <g className="illo-scan">
        <circle cx="96" cy="64" r="24" className="lens stroke-accent" />
        <path d="M113 81l18 18" className="line thick stroke-accent" />
        <circle cx="90" cy="58" r="5" className="glint" />
      </g>
    </>
  ),
  library: () => (
    <>
      <Backdrop seed={61} />
      <g className="illo-float">
        <rect x="64" y="30" width="62" height="80" rx="7" className="soft stroke-ink" transform="rotate(-9 95 110)" />
        <rect x="70" y="28" width="62" height="80" rx="7" className="soft stroke-ink" transform="rotate(5 101 108)" />
        <rect x="68" y="26" width="62" height="80" rx="7" className="paper stroke-accent" />
        {[42, 52, 62, 72, 82].map((y, i) => (
          <path key={y} d={`M78 ${y}h${i === 4 ? 24 : 42}`} className="line stroke-accent illo-write" pathLength={100} style={delay(i * 0.4)} />
        ))}
      </g>
    </>
  ),
  progress: () => (
    <>
      <Backdrop seed={71} />
      <path d="M40 110h124" className="line stroke-ink" />
      {[[52, 30], [78, 46], [104, 40], [130, 64]].map(([x, h], i) => (
        <rect key={x} x={x} y={110 - h} width="16" height={h} rx="4" className="soft-solid stroke-accent illo-grow" style={delay(i * 0.2)} />
      ))}
      <path d="M48 88L80 70 106 76 150 36" className="line stroke-accent illo-draw" pathLength={100} />
      <circle cx="150" cy="36" r="5" className="fill-accent illo-pop" style={delay(1.2)} />
    </>
  ),
  explain: () => (
    <>
      <Backdrop seed={83} />
      {Array.from({ length: 7 }, (_, i) => {
        const a = ((-150 + i * 20) * Math.PI) / 180;
        const [x1, y1, x2, y2] = [100 + Math.cos(a) * 36, 58 + Math.sin(a) * 36, 100 + Math.cos(a) * 46, 58 + Math.sin(a) * 46];
        return <path key={i} d={`M${x1} ${y1}L${x2} ${y2}`} className="line stroke-accent illo-pulse" style={delay(i * 0.15)} />;
      })}
      <g className="illo-glow">
        <path d="M100 32a26 26 0 0 1 15 47v9H85v-9a26 26 0 0 1 15-47z" className="soft stroke-accent" />
        <path d="M90 60l5 6 5-6 5 6 5-6" className="line stroke-accent" />
        <path d="M88 96h24M91 103h18" className="line stroke-ink" />
      </g>
    </>
  ),
  stories: () => (
    <>
      <Backdrop seed={97} />
      {[[86, 40], [104, 34], [120, 44], [96, 28]].map(([x, y], i) => (
        <circle key={i} cx={x} cy={y} r="2.6" className="fill-accent illo-rise" style={delay(i * 0.55)} />
      ))}
      <g className="illo-float">
        <path d="M100 56C84 48 62 48 46 52v50c16-4 38-4 54 4z" className="soft stroke-accent" />
        <path d="M100 56c16-8 38-8 54-4v50c-16-4-38-4-54 4z" className="soft stroke-accent" />
        <path d="M56 64c10-2 22-2 34 2M56 74c10-2 22-2 34 2M110 66c12-4 24-4 34-2M110 76c12-4 24-4 34-2" className="line stroke-ink" />
      </g>
    </>
  ),
  chat: () => (
    <>
      <Backdrop seed={101} />
      <g className="illo-alt">
        <path d="M44 38h62a12 12 0 0 1 12 12v16a12 12 0 0 1-12 12H66l-12 10V78h-10a12 12 0 0 1-12-12V50a12 12 0 0 1 12-12z" className="soft stroke-accent" />
        <path d="M46 55h52M46 64h36" className="line stroke-accent" />
      </g>
      <g className="illo-alt" style={delay(1.4)}>
        <path d="M156 62H94a12 12 0 0 0-12 12v14a12 12 0 0 0 12 12h40l12 10v-10h10a12 12 0 0 0 12-12V74a12 12 0 0 0-12-12z" className="paper stroke-ink" />
        <path d="M96 78h50M96 87h30" className="line stroke-ink" />
      </g>
    </>
  ),
  notes: () => (
    <>
      <Backdrop seed={113} />
      <rect x="66" y="22" width="68" height="92" rx="8" className="paper stroke-accent" />
      {[40, 51, 62, 73, 84].map((y, i) => (
        <path key={y} d={`M78 ${y}h${i % 2 ? 34 : 44}`} className="line stroke-accent illo-write" pathLength={100} style={delay(i * 0.45)} />
      ))}
      <g className="illo-pencil">
        <path d="M128 92l18-18 7 7-18 18-9 2z" className="soft-solid stroke-accent" />
      </g>
    </>
  ),
  score: () => (
    <>
      <Backdrop seed={127} cy={80} />
      <path d="M50 96a50 50 0 0 1 100 0" className="line thick stroke-ink" />
      <path d="M50 96a50 50 0 0 1 100 0" className="line thick stroke-accent illo-draw" pathLength={100} />
      <g className="illo-needle">
        <path d="M100 96L100 56" className="line thick stroke-accent" />
      </g>
      <circle cx="100" cy="96" r="6" className="fill-accent" />
    </>
  ),
  welcome: () => (
    <>
      <Backdrop seed={131} n={90} />
      <g className="illo-spin">
        {arcDots(100, 66, 40, 0, 330, 12).map(([x, y], i) => <circle key={i} cx={x} cy={y} r={i % 3 ? 2 : 3.2} className="fill-accent" />)}
      </g>
      <path d="M100 38l6 18 18 6-18 6-6 18-6-18-18-6 18-6z" className="soft-solid stroke-accent illo-glow" />
    </>
  ),
};

export default function Illustration({ name, size = 168, className = "" }: {
  name: IllustrationName; size?: number; className?: string;
}) {
  return (
    <svg className={`illo ${className}`} viewBox="0 0 200 136" width={size} height={(size * 136) / 200}
      role="img" aria-hidden="true" focusable="false">
      {SCENES[name]()}
    </svg>
  );
}
