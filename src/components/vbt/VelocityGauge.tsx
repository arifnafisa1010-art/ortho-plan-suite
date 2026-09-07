import { velocityZone } from '@/lib/vbt';

interface Props {
  /** kecepatan saat ini (m/s) */
  value: number;
  /** kecepatan maksimum skala */
  max?: number;
  label?: string;
  sublabel?: string;
}

const ZONES = [
  { from: 0, to: 0.5, color: 'hsl(0 72% 51%)', name: 'Max Strength' },
  { from: 0.5, to: 0.75, color: 'hsl(38 92% 50%)', name: 'Strength-Speed' },
  { from: 0.75, to: 1.0, color: 'hsl(199 89% 48%)', name: 'Power' },
  { from: 1.0, to: 1.3, color: 'hsl(217 91% 60%)', name: 'Speed-Strength' },
  { from: 1.3, to: 2.0, color: 'hsl(142 71% 45%)', name: 'Starting Strength' },
];

const CX = 100;
const CY = 100;
const R = 78;
const START = 150; // derajat
const SWEEP = 240;

function polar(angleDeg: number, radius: number) {
  const rad = (angleDeg * Math.PI) / 180;
  return { x: CX + radius * Math.cos(rad), y: CY + radius * Math.sin(rad) };
}

function arc(fromVal: number, toVal: number, max: number, radius: number) {
  const a0 = START + (Math.min(fromVal, max) / max) * SWEEP;
  const a1 = START + (Math.min(toVal, max) / max) * SWEEP;
  const p0 = polar(a0, radius);
  const p1 = polar(a1, radius);
  const large = a1 - a0 > 180 ? 1 : 0;
  return `M ${p0.x} ${p0.y} A ${radius} ${radius} 0 ${large} 1 ${p1.x} ${p1.y}`;
}

/** Spidometer kecepatan angkat (m/s) dengan zona warna load-velocity. */
export function VelocityGauge({ value, max = 2, label = 'Kecepatan', sublabel }: Props) {
  const v = Math.max(0, Math.min(max, Number.isFinite(value) ? value : 0));
  const angle = START + (v / max) * SWEEP;
  const needle = polar(angle, R - 16);
  const zone = velocityZone(v);

  return (
    <div className="flex flex-col items-center">
      <svg viewBox="0 0 200 165" className="w-full max-w-[260px]">
        <path
          d={arc(0, max, max, R)}
          fill="none"
          stroke="hsl(var(--muted))"
          strokeWidth={14}
          strokeLinecap="round"
        />
        {ZONES.map((z) => (
          <path
            key={z.name}
            d={arc(z.from, z.to, max, R)}
            fill="none"
            stroke={z.color}
            strokeWidth={14}
            opacity={0.85}
          />
        ))}
        {Array.from({ length: 9 }, (_, i) => (i * max) / 8).map((tv) => {
          const a = START + (tv / max) * SWEEP;
          const p1 = polar(a, R - 10);
          const p2 = polar(a, R - 2);
          return (
            <line
              key={tv}
              x1={p1.x}
              y1={p1.y}
              x2={p2.x}
              y2={p2.y}
              stroke="hsl(var(--background))"
              strokeWidth={2}
            />
          );
        })}
        <line
          x1={CX}
          y1={CY}
          x2={needle.x}
          y2={needle.y}
          stroke="hsl(var(--foreground))"
          strokeWidth={4}
          strokeLinecap="round"
          style={{ transition: 'all 120ms linear' }}
        />
        <circle cx={CX} cy={CY} r={7} fill="hsl(var(--foreground))" />
        <text
          x={CX}
          y={CY + 34}
          textAnchor="middle"
          className="fill-foreground"
          style={{ fontSize: 26, fontWeight: 700 }}
        >
          {v.toFixed(2)}
        </text>
        <text
          x={CX}
          y={CY + 50}
          textAnchor="middle"
          className="fill-muted-foreground"
          style={{ fontSize: 11 }}
        >
          m/s
        </text>
      </svg>
      <p className="text-sm font-semibold">{label}</p>
      <p className="text-xs text-muted-foreground text-center">{sublabel ?? zone.label}</p>
    </div>
  );
}
