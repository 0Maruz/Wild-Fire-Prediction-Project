import { useState } from "react";

// Reusable card for showing a single ML metric with:
//   • plain-language label
//   • current value (big number)
//   • a 0..1 (or custom) range bar with markers showing what "good" is
//   • a click-to-expand info panel explaining the metric + good range
//
// Designed so non-ML readers can understand each number at a glance and
// drill in for detail without leaving the page.

export type MetricStatus = "great" | "good" | "ok" | "warn" | "bad";

interface RangeMarker {
  position: number;            // 0..1 along the scale bar
  label: string;
  color: string;
}

interface Props {
  label: string;
  value: string;               // already-formatted ("0.85", "97%", "3.4×")
  statusLabel?: string;        // e.g. "ดีมาก", "ปานกลาง"
  status: MetricStatus;
  // Optional visual scale bar
  range?: {
    min: number;
    max: number;
    current: number;           // value within [min, max] to highlight
    markers?: RangeMarker[];   // dividers between status zones
  };
  // What this metric measures + what range is "good"
  description: string;
  goodRange: string;
  // Smaller secondary text shown below the value (e.g. "across 17 months")
  subtitle?: string;
  highlight?: boolean;         // visual emphasis for hero card
}

const STATUS_COLORS: Record<MetricStatus, string> = {
  great: "#22c55e",   // green
  good:  "#84cc16",   // light-green
  ok:    "#eab308",   // yellow
  warn:  "#f59e0b",   // orange
  bad:   "#ef4444",   // red
};

const STATUS_BG: Record<MetricStatus, string> = {
  great: "rgba(34, 197, 94, 0.10)",
  good:  "rgba(132, 204, 22, 0.10)",
  ok:    "rgba(234, 179, 8, 0.10)",
  warn:  "rgba(245, 158, 11, 0.10)",
  bad:   "rgba(239, 68, 68, 0.10)",
};

export default function MetricCard({
  label, value, statusLabel, status, range, description, goodRange,
  subtitle, highlight = false,
}: Props) {
  const [expanded, setExpanded] = useState(false);
  const color = STATUS_COLORS[status];
  const bg = STATUS_BG[status];

  return (
    <div
      className={`metric-card${highlight ? " metric-card-highlight" : ""}`}
      style={{
        borderLeftColor: color,
        background: highlight ? bg : undefined,
      }}
    >
      <div className="metric-card-head">
        <div className="metric-card-label">{label}</div>
        <button
          className="metric-card-help"
          type="button"
          onClick={() => setExpanded((v) => !v)}
          aria-label={expanded ? "Hide info" : "What is this?"}
          title={expanded ? "ซ่อนรายละเอียด" : "ค่านี้คืออะไร?"}
        >
          {expanded ? "−" : "?"}
        </button>
      </div>

      <div className="metric-card-value" style={{ color }}>
        {value}
        {statusLabel && (
          <span className="metric-card-status" style={{ color }}>
            {statusLabel}
          </span>
        )}
      </div>
      {subtitle && <div className="metric-card-subtitle">{subtitle}</div>}

      {range && (
        <RangeBar
          min={range.min}
          max={range.max}
          current={range.current}
          markers={range.markers ?? []}
          color={color}
        />
      )}

      {expanded && (
        <div className="metric-card-expand">
          <div className="metric-card-section">
            <div className="metric-card-section-label">ความหมาย</div>
            <div className="metric-card-section-text">{description}</div>
          </div>
          <div className="metric-card-section">
            <div className="metric-card-section-label">ค่าที่ดี</div>
            <div className="metric-card-section-text">{goodRange}</div>
          </div>
        </div>
      )}
    </div>
  );
}

interface RangeBarProps {
  min: number;
  max: number;
  current: number;
  markers: RangeMarker[];
  color: string;
}

// Inline scale bar with markers for status thresholds + current-value pin.
function RangeBar({ min, max, current, markers, color }: RangeBarProps) {
  const span = max - min;
  const pct = (v: number) => Math.max(0, Math.min(1, (v - min) / span)) * 100;
  const currentPct = pct(current);
  return (
    <div className="metric-card-range">
      <div className="metric-card-range-track">
        {markers.map((m, i) => (
          <div
            key={i}
            className="metric-card-range-marker"
            style={{ left: `${pct(min + m.position * span)}%`, background: m.color }}
            title={m.label}
          />
        ))}
        <div
          className="metric-card-range-pin"
          style={{ left: `${currentPct}%`, background: color }}
        />
      </div>
      <div className="metric-card-range-axis">
        <span>{min}</span>
        <span>{max}</span>
      </div>
    </div>
  );
}
