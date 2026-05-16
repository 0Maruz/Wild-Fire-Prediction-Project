import { useMemo } from "react";
import type { FireFeature } from "../types";

interface Props {
  allFeatures: FireFeature[];  // ALL features from GeoJSON (not just current snapshot)
}

// Retrospective validation panel — answers "do past predictions actually
// match reality?". The append-mode GeoJSON tags every past prediction with
// validation_status:
//   "hit"    — a real fire happened within the predicted ±1-day window
//   "miss"   — no real fire (or fire happened far outside the window)
//   "future" — prediction window hasn't closed yet
//
// We aggregate by base_date so the operator can see a track-record across
// the last N runs. This is the strongest "we're not making it up" signal:
// past commitments + observable outcomes.
interface BaseDateStats {
  baseDate: string;
  hits: number;
  misses: number;
  future: number;
  total: number;
  hitRate: number;             // hits / decided (excludes future)
  byTier: Record<string, { hit: number; miss: number; future: number }>;
}

function aggregate(features: FireFeature[]): BaseDateStats[] {
  const map = new Map<string, BaseDateStats>();
  for (const f of features) {
    const p = f.properties;
    const bd = p.base_date;
    const st = p.validation_status;
    if (!bd || !st) continue;
    let entry = map.get(bd);
    if (!entry) {
      entry = {
        baseDate: bd,
        hits: 0,
        misses: 0,
        future: 0,
        total: 0,
        hitRate: 0,
        byTier: {},
      };
      map.set(bd, entry);
    }
    entry.total += 1;
    if (st === "hit") entry.hits += 1;
    else if (st === "miss") entry.misses += 1;
    else if (st === "future") entry.future += 1;

    const tier = (p.urgency_level ?? "NONE") as string;
    if (!entry.byTier[tier]) entry.byTier[tier] = { hit: 0, miss: 0, future: 0 };
    if (st in entry.byTier[tier]) {
      entry.byTier[tier][st as "hit" | "miss" | "future"] += 1;
    }
  }
  return Array.from(map.values())
    .map((e) => ({
      ...e,
      hitRate: e.hits + e.misses > 0 ? e.hits / (e.hits + e.misses) : 0,
    }))
    .sort((a, b) => b.baseDate.localeCompare(a.baseDate));
}

const TIER_COLORS: Record<string, string> = {
  CRITICAL: "#ef4444",
  HIGH: "#f97316",
  MEDIUM: "#eab308",
  LOW: "#22c55e",
};

export default function RetrospectivePanel({ allFeatures }: Props) {
  const stats = useMemo(() => aggregate(allFeatures), [allFeatures]);

  // Overall summary across all decided rows (excluding future)
  const overall = useMemo(() => {
    let hit = 0, miss = 0, future = 0;
    for (const s of stats) {
      hit += s.hits;
      miss += s.misses;
      future += s.future;
    }
    const decided = hit + miss;
    return { hit, miss, future, decided, rate: decided ? hit / decided : 0 };
  }, [stats]);

  if (stats.length === 0) {
    return (
      <div className="section">
        <h3>🎯 Past Predictions</h3>
        <p style={{ fontSize: 11, color: "var(--text-3)" }}>
          ยังไม่มีข้อมูล retrospective. Predictions ใหม่จะถูก validate อัตโนมัติ
          เมื่อเวลาผ่านไป
        </p>
      </div>
    );
  }

  return (
    <div className="section">
      <h3>🎯 Past Predictions (Real Outcomes)</h3>
      <p style={{ fontSize: 11, color: "var(--text-3)", marginBottom: 8 }}>
        Predictions ในอดีต vs FIRMS ground truth — track record ทุก base_date
      </p>

      {/* Overall summary */}
      <div
        style={{
          padding: "10px 12px",
          background: "var(--surface-2)",
          borderRadius: 6,
          marginBottom: 10,
          border: "1px solid var(--border)",
        }}
      >
        <div style={{ fontSize: 10, fontWeight: 600, color: "var(--text-3)", textTransform: "uppercase", letterSpacing: "0.06em" }}>
          Overall track record
        </div>
        <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginTop: 4 }}>
          <span style={{ fontSize: 24, fontWeight: 700, color: overall.rate >= 0.4 ? "#22c55e" : overall.rate >= 0.2 ? "#eab308" : "#ef4444" }}>
            {(overall.rate * 100).toFixed(1)}%
          </span>
          <span style={{ fontSize: 11, color: "var(--text-2)" }}>
            {overall.hit} hits / {overall.decided} validated  ({overall.future} pending)
          </span>
        </div>
      </div>

      {/* Per base_date table */}
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        {stats.slice(0, 8).map((s) => {
          const decided = s.hits + s.misses;
          const isFutureOnly = decided === 0 && s.future > 0;
          const color = isFutureOnly
            ? "var(--text-3)"
            : s.hitRate >= 0.5 ? "#22c55e"
            : s.hitRate >= 0.25 ? "#eab308"
            : "#ef4444";
          return (
            <div
              key={s.baseDate}
              style={{
                padding: "8px 10px",
                background: "var(--surface)",
                borderRadius: 4,
                border: "1px solid var(--border)",
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                fontSize: 12,
                gap: 8,
              }}
            >
              <div style={{ minWidth: 78 }}>
                <div style={{ fontWeight: 600, color: "var(--text)" }}>{s.baseDate}</div>
                <div style={{ fontSize: 10, color: "var(--text-3)", marginTop: 2 }}>
                  {s.total} cells
                </div>
              </div>
              <div style={{ display: "flex", gap: 4, flex: 1 }}>
                {(["CRITICAL", "HIGH", "MEDIUM", "LOW"] as const).map((tier) => {
                  const t = s.byTier[tier] ?? { hit: 0, miss: 0, future: 0 };
                  const td = t.hit + t.miss;
                  if (td === 0 && t.future === 0) return null;
                  return (
                    <div
                      key={tier}
                      title={`${tier}: hit=${t.hit}, miss=${t.miss}, future=${t.future}`}
                      style={{
                        padding: "2px 6px",
                        borderRadius: 3,
                        background: TIER_COLORS[tier] + "22",
                        border: `1px solid ${TIER_COLORS[tier]}66`,
                        fontSize: 10,
                        color: TIER_COLORS[tier],
                        fontWeight: 600,
                        whiteSpace: "nowrap",
                      }}
                    >
                      {tier.charAt(0)} {td > 0 ? `${t.hit}/${td}` : `+${t.future}`}
                    </div>
                  );
                })}
              </div>
              <div style={{ textAlign: "right", minWidth: 56 }}>
                {isFutureOnly ? (
                  <span style={{ color: "var(--text-3)", fontSize: 11 }}>pending</span>
                ) : (
                  <>
                    <div style={{ fontSize: 16, fontWeight: 700, color }}>
                      {(s.hitRate * 100).toFixed(0)}%
                    </div>
                    <div style={{ fontSize: 9, color: "var(--text-3)" }}>
                      hit rate
                    </div>
                  </>
                )}
              </div>
            </div>
          );
        })}
      </div>

      <p style={{ fontSize: 10, color: "var(--text-3)", marginTop: 8, lineHeight: 1.45 }}>
        <b>Hit</b> = predicted cell มี FIRMS hotspot ภายในช่วงที่ทำนาย ±1 วัน ·{" "}
        <b>Miss</b> = ไม่มี · <b>Pending</b> = window ยังไม่ปิด.<br/>
        คำนวณจาก append-mode GeoJSON ตอน <code style={{ background: "var(--surface-2)", padding: "0 3px", borderRadius: 2 }}>risk_map.py</code> รันแต่ละครั้ง
      </p>
    </div>
  );
}
