import { useEffect, useMemo, useState } from "react";
import type { FireFeature, ValidationMetrics } from "../types";

interface Props {
  open: boolean;
  onClose: () => void;
  predicted: FireFeature[];
  metrics: ValidationMetrics | null;
}

// Lets the operator slide a probability-threshold and see live counts of:
//   • how many cells would be alerted at this threshold
//   • estimated precision/recall (interpolated from reliability bins)
//   • visual urgency-tier breakdown
//
// Educational — helps non-ML operators understand the precision/recall
// trade-off in concrete terms ("alert 200 cells vs 50 cells").
export default function AlertSettings({ open, onClose, predicted, metrics }: Props) {
  // Default to deployment threshold from metadata, fall back 0.5
  const defaultThr = metrics?.deployment_threshold ?? 0.5;
  const [thr, setThr] = useState<number>(defaultThr);

  useEffect(() => {
    setThr(defaultThr);
  }, [defaultThr]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  // Pre-compute per-cell probability from raw_prediction (pseudo-days)
  // raw_prediction was produced by the piecewise mapping; invert by inferring
  // probability from the pseudo-days value.
  const cellProbabilities = useMemo(() => {
    return predicted
      .map((f) => {
        const raw = f.properties.raw_prediction;
        if (typeof raw !== "number" || !isFinite(raw)) return null;
        // Old mapping: prob = 1 - (raw - 1) / 6
        // Match the latest piecewise mapping anchor points
        return Math.max(0, Math.min(1, 1 - (raw - 1) / 6));
      })
      .filter((p): p is number => p !== null);
  }, [predicted]);

  // Live counts at chosen threshold
  const aboveThr = cellProbabilities.filter((p) => p >= thr).length;
  const belowThr = cellProbabilities.length - aboveThr;
  const pctAlerts = cellProbabilities.length
    ? (aboveThr / cellProbabilities.length) * 100
    : 0;

  // Interpolate precision/recall from reliability bins (if available).
  // This is an approximation — true precision/recall require test labels.
  const reliability = metrics?.reliability_bins ?? [];
  let estPrecision: number | null = null;
  let estRecall: number | null = null;
  if (reliability.length > 0) {
    // Find the bin containing our threshold; the bin's actual_rate ≈ precision
    const bin = reliability.find((b) => thr >= b.bin_lower && thr < b.bin_upper);
    if (bin) estPrecision = bin.actual_rate;
    // Recall ≈ sum of (bin.actual_rate * bin.count) for bins above threshold,
    // divided by total positives.
    let truePos = 0;
    let allPos = 0;
    for (const b of reliability) {
      const binCenter = (b.bin_lower + b.bin_upper) / 2;
      const positives = b.actual_rate * b.count;
      allPos += positives;
      if (binCenter >= thr) truePos += positives;
    }
    estRecall = allPos > 0 ? truePos / allPos : 0;
  }

  if (!open) return null;

  return (
    <div className="info-modal-backdrop" role="dialog" aria-modal="true" onClick={onClose}>
      <div className="info-modal" onClick={(e) => e.stopPropagation()}>
        <div className="info-modal-header">
          <h2>⚙️ Alert Threshold Settings</h2>
          <button className="info-modal-close" onClick={onClose} aria-label="Close">×</button>
        </div>

        <div className="info-modal-body">
          <p style={{ color: "var(--text-2)", marginBottom: 8 }}>
            เลื่อน threshold เพื่อดูว่าจะเตือนกี่ cells, precision/recall จะเป็นยังไง
          </p>

          <div className="threshold-slider-row">
            <input
              type="range"
              className="threshold-slider"
              min={0.05}
              max={0.95}
              step={0.05}
              value={thr}
              onChange={(e) => setThr(Number(e.target.value))}
            />
            <div className="threshold-value">{thr.toFixed(2)}</div>
          </div>

          <div style={{ display: "flex", gap: 8, marginTop: 4 }}>
            {[0.10, 0.25, 0.35, 0.50, 0.70].map((preset) => (
              <button
                key={preset}
                type="button"
                onClick={() => setThr(preset)}
                className="action-btn"
                style={{ flex: 1, padding: "4px 6px", fontSize: 11 }}
              >
                {preset.toFixed(2)}
              </button>
            ))}
          </div>

          <section style={{ marginTop: 18 }}>
            <h3>ผลที่ threshold = {thr.toFixed(2)}</h3>
            <div className="info-grid">
              <div>
                <span>Alert cells</span>
                <b style={{ color: "#ef4444" }}>{aboveThr}</b>
              </div>
              <div>
                <span>No-alert cells</span>
                <b>{belowThr}</b>
              </div>
              <div>
                <span>% alerted</span>
                <b>{pctAlerts.toFixed(1)}%</b>
              </div>
              <div>
                <span>Est. precision</span>
                <b style={{ color: "#84cc16" }}>
                  {estPrecision != null ? `${(estPrecision * 100).toFixed(1)}%` : "—"}
                </b>
              </div>
              <div>
                <span>Est. recall</span>
                <b style={{ color: "#22c55e" }}>
                  {estRecall != null ? `${(estRecall * 100).toFixed(1)}%` : "—"}
                </b>
              </div>
              <div>
                <span>Deployment thr</span>
                <b>{defaultThr.toFixed(2)}</b>
              </div>
            </div>
            <p className="info-note" style={{ marginTop: 8 }}>
              <b>Estimated</b> = interpolated จาก reliability bins ของ test set —
              ค่าจริงอาจต่างถ้า distribution ใน production ต่างจาก test
            </p>
          </section>

          <section style={{ marginTop: 18 }}>
            <h3>คำแนะนำ</h3>
            <ul style={{ paddingLeft: 18, color: "var(--text-2)", lineHeight: 1.6, fontSize: 12 }}>
              <li><b>threshold ต่ำ (0.05–0.20):</b> เตือนเยอะ — เกือบไม่พลาดไฟ แต่ false alarm สูง</li>
              <li><b>threshold กลาง (0.30–0.50):</b> สมดุล — แนะนำสำหรับ daily monitoring</li>
              <li><b>threshold สูง (0.60+):</b> เตือนน้อย — เฉพาะที่ confident มาก พลาดไฟบ้าง</li>
              <li><b>Deployment threshold ({defaultThr.toFixed(2)}):</b> ค่าที่ F1-optimal บน held-out test</li>
            </ul>
          </section>

          <section style={{ marginTop: 18 }}>
            <h3>วิธีใช้</h3>
            <p style={{ color: "var(--text-2)", fontSize: 12, lineHeight: 1.5 }}>
              ค่า threshold ที่ตั้งใน modal นี้ <b>ยังไม่ apply กับ dashboard จริง</b> —
              เป็น preview ให้ดูตัวเลขเฉยๆ. ถ้าจะเปลี่ยน threshold deployment ให้แก้
              <code style={{ background: "var(--surface-2)", padding: "1px 4px", borderRadius: 3 }}>train.py</code>
              {" "}แล้วเทรนใหม่ หรือใช้ JSON metadata `deployment_threshold` field
            </p>
          </section>
        </div>
      </div>
    </div>
  );
}
