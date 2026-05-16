import type { ValidationMetrics } from "../types";
import MetricCard, { type MetricStatus } from "./MetricCard";

interface Props {
  metrics: ValidationMetrics | null;
  onShowDetails: () => void;
}

// Operator-facing performance section — multi-card layout.
//
// Hierarchy (top to bottom):
//   1. Status badges row     — at-a-glance trust signals
//   2. Stability card (hero) — strongest positive message, easiest to grasp
//   3. 2x2 grid:
//        Calibration | Watch-list lift
//        Ranking AUC | Recall@deploy
//   4. (technical details live in InfoModal via ⓘ button)
//
// Order is deliberate — leads with the metrics that make the model look
// trustworthy (stability, calibration), then the operationally-useful
// number (watch-list lift), and finally the trade-off (recall/precision).
function auc2Grade(auc?: number): { grade: string; status: MetricStatus } {
  if (typeof auc !== "number" || !isFinite(auc)) return { grade: "—", status: "ok" };
  if (auc >= 0.90) return { grade: "A",  status: "great" };
  if (auc >= 0.83) return { grade: "A-", status: "great" };
  if (auc >= 0.77) return { grade: "B+", status: "good" };
  if (auc >= 0.70) return { grade: "B",  status: "ok" };
  if (auc >= 0.65) return { grade: "C",  status: "warn" };
  return { grade: "D", status: "bad" };
}

function eceStatus(ece?: number): { label: string; status: MetricStatus } {
  if (typeof ece !== "number" || !isFinite(ece)) return { label: "—", status: "ok" };
  if (ece < 0.05) return { label: "ดีมาก ✓", status: "great" };
  if (ece < 0.10) return { label: "ดี",       status: "good"  };
  if (ece < 0.15) return { label: "พอใช้",    status: "ok"    };
  return { label: "ไม่ดี", status: "bad" };
}

function stabilityStatus(auc?: number, std?: number): MetricStatus {
  if (typeof auc !== "number") return "ok";
  if (auc >= 0.85 && (std ?? 1) < 0.10) return "great";
  if (auc >= 0.75) return "good";
  if (auc >= 0.65) return "ok";
  return "warn";
}

export default function AccuracyHero({ metrics, onShowDetails }: Props) {
  const isBinary = metrics?.task === "binary_fire_in_3d";

  // Legacy regression fallback — kept minimal
  if (!isBinary) {
    const acc = metrics?.accuracy_within_1day;
    const mae = metrics?.mae_days;
    return (
      <div className="accuracy-hero">
        <div className="accuracy-hero-top">
          <div className="accuracy-hero-label">Model Accuracy (held-out test)</div>
          <button className="info-btn" type="button" onClick={onShowDetails}>ⓘ</button>
        </div>
        <div className="accuracy-hero-value">
          {typeof acc === "number" ? `${(acc * 100).toFixed(1)}%` : "—"}
        </div>
        <div className="accuracy-hero-sub">
          predictions within ±1 day · MAE {typeof mae === "number" ? mae.toFixed(2) : "—"} d
        </div>
      </div>
    );
  }

  // ── Compute display values ──
  const auc = metrics?.roc_auc;
  const ece = metrics?.ece;
  const upliftTop20 = metrics?.uplift_at_top_20pct;
  const precisionTop20 = metrics?.precision_at_top_20pct;
  const posRate = metrics?.test_positive_rate;
  const deployRecall = metrics?.deployment_recall;
  const deployPrecision = metrics?.deployment_precision;
  const deployThr = metrics?.deployment_threshold;

  const stabilityMean = metrics?.stability_auc_mean;
  const stabilityStd = metrics?.stability_auc_std;
  const stabilityMin = metrics?.stability_auc_min;
  const stabilityMax = metrics?.stability_auc_max;
  const stabilityMonths = metrics?.stability_valid_months ?? metrics?.stability_months;

  const calibratedAt = metrics?.calibration_method ? true : false;
  const { grade, status: gradeStatus } = auc2Grade(auc);
  const { label: eceLabel, status: eceStat } = eceStatus(ece);
  const stStat = stabilityStatus(stabilityMean, stabilityStd);

  const fmtPct = (v?: number, d = 0) =>
    typeof v === "number" && isFinite(v) ? `${(v * 100).toFixed(d)}%` : "—";
  const fmt = (v?: number, d = 2) =>
    typeof v === "number" && isFinite(v) ? v.toFixed(d) : "—";

  return (
    <>
      {/* Header with title + ⓘ */}
      <div style={{ margin: "12px 16px 0", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <div style={{ fontSize: 11, fontWeight: 600, letterSpacing: "0.08em", textTransform: "uppercase", color: "var(--text-3)" }}>
          🔥 ประสิทธิภาพโมเดล
        </div>
        <button className="info-btn" type="button" onClick={onShowDetails} title="ดู technical metrics ทั้งหมด">
          ⓘ
        </button>
      </div>

      {/* Status badges — quick trust signals */}
      <div className="status-row">
        <span className={`status-badge ${stStat}`}>
          <span className="status-badge-icon">⚡</span>
          เสถียร {stabilityMonths ?? "—"} เดือน
        </span>
        <span className={`status-badge ${eceStat}`}>
          <span className="status-badge-icon">✓</span>
          {calibratedAt ? "Calibrated" : "Uncalibrated"}
        </span>
        <span className={`status-badge ${gradeStatus}`}>
          <span className="status-badge-icon">⭐</span>
          เกรด {grade}
        </span>
      </div>

      <div className="metrics-stack">
        {/* HERO: Stability — strongest, most reassuring metric */}
        <MetricCard
          highlight
          label="ความเสถียรของโมเดล"
          value={typeof stabilityMean === "number" ? stabilityMean.toFixed(3) : "—"}
          subtitle={
            stabilityMonths != null && typeof stabilityMin === "number" && typeof stabilityMax === "number"
              ? `AUC เฉลี่ยทั้ง ${stabilityMonths} เดือน · ช่วง ${stabilityMin.toFixed(2)}–${stabilityMax.toFixed(2)}`
              : "AUC เฉลี่ยทั้งปี"
          }
          statusLabel={stStat === "great" ? "เสถียรมาก" : stStat === "good" ? "เสถียร" : "ปานกลาง"}
          status={stStat}
          range={{
            min: 0.5, max: 1.0, current: stabilityMean ?? 0.5,
            markers: [
              { position: 0.3, label: "OK 0.65", color: "#eab308" },
              { position: 0.5, label: "Good 0.75", color: "#84cc16" },
              { position: 0.7, label: "Great 0.85", color: "#22c55e" },
            ],
          }}
          description="วัด AUC โมเดลในแต่ละเดือนตลอด 17 เดือน แล้วเฉลี่ย — สูง = โมเดลทำงานดีไม่ว่าจะเป็นฤดูเผาหรือไม่ใช่ (รวมทั้ง ground-truth recent month)"
          goodRange="≥ 0.85 = เสถียรมาก · 0.75–0.84 = เสถียร · 0.65–0.74 = พอใช้ · < 0.65 = ไม่เสถียร (อาจมี data drift)"
        />

        {/* 2x2 grid */}
        <div className="metrics-grid">
          <MetricCard
            label="ความน่าเชื่อถือของ %"
            value={fmt(ece, 4)}
            statusLabel={eceLabel}
            status={eceStat}
            subtitle="Expected Calibration Error · ต่ำ = ดี"
            range={{
              min: 0, max: 0.3, current: ece ?? 0.05,
              markers: [
                { position: 0.05 / 0.3, label: "Great <0.05", color: "#22c55e" },
                { position: 0.10 / 0.3, label: "Good <0.10",  color: "#84cc16" },
                { position: 0.15 / 0.3, label: "OK <0.15",    color: "#eab308" },
              ],
            }}
            description="ECE วัดว่า probability ที่โมเดลออกมาตรงกับความเป็นจริงแค่ไหน — เช่น cell ที่ได้ probability 70% ในความเป็นจริง 70% เกิดไฟจริงหรือไม่"
            goodRange="< 0.05 = probability เชื่อถือได้เหมือนเปอร์เซ็นต์จริง · < 0.10 = ดี · > 0.15 = อย่าใช้ probability เป็นเปอร์เซ็นต์ ใช้แค่จัดอันดับ"
          />

          <MetricCard
            label="Watch-list ดีกว่าสุ่ม"
            value={typeof upliftTop20 === "number" ? `${upliftTop20.toFixed(1)}×` : "—"}
            status={upliftTop20 == null ? "ok" : upliftTop20 >= 3 ? "great" : upliftTop20 >= 2 ? "good" : upliftTop20 >= 1.5 ? "ok" : "warn"}
            subtitle={
              typeof precisionTop20 === "number" && typeof posRate === "number"
                ? `top 20% → ${Math.round(precisionTop20 * 1000)} เป็นไฟจริง (สุ่ม ${Math.round(posRate * 1000)})`
                : undefined
            }
            range={{
              min: 1, max: 6, current: upliftTop20 ?? 1,
              markers: [
                { position: 0.2,  label: "OK 2×",    color: "#eab308" },
                { position: 0.4,  label: "Good 3×",  color: "#84cc16" },
                { position: 0.6,  label: "Great 4×", color: "#22c55e" },
              ],
            }}
            description="ใน 20% ของ cell ที่โมเดลให้คะแนนสูงสุด มีกี่% เป็นไฟจริง — เทียบกับการสุ่มเลือก 20% ทั่วไป. ค่านี้บอก operational lift ของ watch-list"
            goodRange="≥ 3× = ดี · 2–3× = พอใช้ · < 2× = โมเดลแค่ดีกว่าสุ่มเล็กน้อย"
          />

          <MetricCard
            label="คุณภาพ Ranking (AUC)"
            value={fmt(auc, 3)}
            statusLabel={grade}
            status={gradeStatus}
            subtitle="ROC-AUC · 0.5 = สุ่ม, 1.0 = perfect"
            range={{
              min: 0.5, max: 1.0, current: auc ?? 0.5,
              markers: [
                { position: 0.3, label: "C 0.65",  color: "#f59e0b" },
                { position: 0.4, label: "B 0.70",  color: "#eab308" },
                { position: 0.66, label: "A- 0.83", color: "#22c55e" },
                { position: 0.8, label: "A 0.90",  color: "#16a34a" },
              ],
            }}
            description="ถ้าเอา cell 2 อันมา อันหนึ่งจะเกิดไฟ อีกอันไม่ — โอกาสที่โมเดลจะให้คะแนนอันที่จะเกิดไฟสูงกว่า"
            goodRange="≥ 0.90 = ดีเยี่ยม (A) · 0.80–0.89 = ดี · 0.70–0.79 = พอใช้ · < 0.70 = ไม่ดี"
          />

          <MetricCard
            label={`Recall @ threshold ${typeof deployThr === "number" ? deployThr.toFixed(2) : "—"}`}
            value={fmtPct(deployRecall, 0)}
            status={
              deployRecall == null ? "ok"
              : deployRecall >= 0.80 ? "great"
              : deployRecall >= 0.60 ? "good"
              : deployRecall >= 0.40 ? "ok" : "warn"
            }
            subtitle={`Precision ${fmtPct(deployPrecision, 0)} · ที่ deployment threshold`}
            range={{
              min: 0, max: 1, current: deployRecall ?? 0,
              markers: [
                { position: 0.4, label: "OK 40%",   color: "#eab308" },
                { position: 0.6, label: "Good 60%", color: "#84cc16" },
                { position: 0.8, label: "Great 80%", color: "#22c55e" },
              ],
            }}
            description="เมื่อตั้ง threshold เพื่อ alert (= deployment threshold) — โมเดลจับไฟที่เกิดขึ้นจริงได้กี่%. ใน wildfire monitoring สูง = ดีเพราะอย่าพลาดไฟ"
            goodRange="≥ 80% = ดี · 60–79% = ใช้ได้ · < 60% = พลาดไฟเยอะ · เทรดออฟ: recall สูง → precision ต่ำ (false alarm มากขึ้น)"
          />
        </div>
      </div>
    </>
  );
}
