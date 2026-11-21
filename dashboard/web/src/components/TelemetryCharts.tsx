import { useId } from "react";

interface SparklineProps {
  values: number[];
  color?: string;
  height?: number;
  max?: number;
  autoScale?: boolean;
  ariaLabel?: string;
}

/** Smooth zero-dependency SVG area sparkline for live telemetry KPIs. */
export function SparklineArea({
  values,
  color = "var(--accent)",
  height = 42,
  max = 100,
  autoScale = true,
  ariaLabel = "Telemetry trend",
}: SparklineProps) {
  const gradientId = useId();
  const width = 180;
  const padY = 5;

  // Ensure at least two points for a smooth visual baseline
  const pts =
    values.length === 0
      ? [0, 0]
      : values.length === 1
        ? [values[0]!, values[0]!]
        : values;

  const rawMin = Math.min(...pts);
  const rawMax = Math.max(...pts);

  let floor = 0;
  let ceiling = Math.max(max, rawMax, 1);

  if (autoScale) {
    const spread = rawMax - rawMin;
    const minSpan = Math.max(8, spread * 1.45);
    const mid = (rawMin + rawMax) / 2;
    floor = Math.max(0, mid - minSpan / 2);
    ceiling = Math.min(Math.max(max, rawMax), floor + minSpan);
    if (ceiling - floor < 1) {
      floor = Math.max(0, rawMin - 4);
      ceiling = floor + 8;
    }
  }

  const span = Math.max(1, ceiling - floor);
  const coords = pts.map((val, idx) => {
    const x = (idx / (pts.length - 1)) * width;
    const normalized = Math.max(0, Math.min(1, (val - floor) / span));
    const y = height - padY - normalized * (height - padY * 2);
    return { x, y };
  });

  // Smooth quadratic midpoint path for organic telemetry curves
  let linePath = `M${coords[0]!.x.toFixed(1)},${coords[0]!.y.toFixed(1)}`;
  for (let i = 1; i < coords.length; i++) {
    const prev = coords[i - 1]!;
    const curr = coords[i]!;
    const midX = ((prev.x + curr.x) / 2).toFixed(1);
    const midY = ((prev.y + curr.y) / 2).toFixed(1);
    linePath += ` Q${prev.x.toFixed(1)},${prev.y.toFixed(1)} ${midX},${midY}`;
  }
  const last = coords.at(-1)!;
  linePath += ` L${last.x.toFixed(1)},${last.y.toFixed(1)}`;

  const areaPath = `${linePath} L${width},${height} L0,${height} Z`;

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      className="w-full overflow-visible"
      style={{ height }}
      role="img"
      aria-label={ariaLabel}
      preserveAspectRatio="none"
    >
      <defs>
        <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity="0.3" />
          <stop offset="100%" stopColor={color} stopOpacity="0.02" />
        </linearGradient>
      </defs>
      <line
        x1="0"
        y1={(height * 0.5).toFixed(1)}
        x2={width}
        y2={(height * 0.5).toFixed(1)}
        stroke="var(--border-subtle)"
        strokeDasharray="3 3"
        strokeWidth="1"
        vectorEffect="non-scaling-stroke"
      />
      <path d={areaPath} fill={`url(#${gradientId})`} />
      <path
        d={linePath}
        fill="none"
        stroke={color}
        strokeWidth="1.9"
        strokeLinecap="round"
        strokeLinejoin="round"
        vectorEffect="non-scaling-stroke"
      />
      <circle
        cx={last.x}
        cy={last.y}
        r="4.5"
        fill={color}
        fillOpacity="0.22"
      />
      <circle cx={last.x} cy={last.y} r="2.4" fill={color} />
    </svg>
  );
}

interface ResourceRingProps {
  percent: number;
  size?: number;
  strokeWidth?: number;
  color?: string;
  label?: string;
}

/** Crisp SVG radial progress ring for health score and resource gauges. */
export function ResourceRing({
  percent,
  size = 64,
  strokeWidth = 5.5,
  color = "var(--success)",
  label,
}: ResourceRingProps) {
  const clamped = Math.max(0, Math.min(100, percent));
  const radius = (size - strokeWidth) / 2;
  const circumference = 2 * Math.PI * radius;
  const offset = circumference - (clamped / 100) * circumference;

  return (
    <div
      className="relative inline-flex items-center justify-center"
      style={{ width: size, height: size }}
    >
      <svg width={size} height={size} className="-rotate-90" aria-hidden="true">
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke="var(--border-default)"
          strokeWidth={strokeWidth}
        />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke={color}
          strokeWidth={strokeWidth}
          strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={offset}
          style={{ transition: "stroke-dashoffset 400ms cubic-bezier(0.16, 1, 0.3, 1)" }}
        />
      </svg>
      <span className="tabular-nums absolute text-xs font-semibold text-[var(--text-primary)]">
        {label ?? `${Math.round(clamped)}%`}
      </span>
    </div>
  );
}

interface CapacityBarProps {
  percent: number;
  tone?: "accent" | "success" | "warning" | "danger" | "violet";
  heightClass?: string;
}

export function CapacityBar({
  percent,
  tone,
  heightClass = "h-1.5",
}: CapacityBarProps) {
  const clamped = Math.max(0, Math.min(100, percent));
  const resolvedTone =
    tone ??
    (clamped >= 85 ? "danger" : clamped >= 70 ? "warning" : "accent");

  const fillVar =
    resolvedTone === "danger"
      ? "var(--danger)"
      : resolvedTone === "warning"
        ? "var(--warning)"
        : resolvedTone === "success"
          ? "var(--success)"
          : resolvedTone === "violet"
            ? "var(--violet)"
            : "var(--accent)";

  return (
    <div
      className={`w-full overflow-hidden rounded-full bg-[var(--border-subtle)] ${heightClass}`}
    >
      <div
        className="h-full rounded-full transition-all duration-300"
        style={{
          width: `${clamped}%`,
          backgroundColor: fillVar,
        }}
      />
    </div>
  );
}
