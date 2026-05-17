import { useEffect } from "react";
import type {
  FireFeature,
  GeoJsonMetadata,
  GistdaFeature,
  ReliabilityBin,
  UrgencyThresholds,
  ValidationMetrics,
} from "../types";

// Small inline SVG reliability diagram. Pure DOM, no chart library.
// X = mean predicted probability per bin; Y = actual positive rate.
// Red diagonal = perfect calibration. Closer to diagonal = better.
function ReliabilityDiagram({ bins }: { bins: ReliabilityBin[] }) {
  if (!bins.length) return null;
  const W = 280;
  const H = 200;
  const PAD = 30;
  const plotW = W - 2 * PAD;
  const plotH = H - 2 * PAD;
  const xToPx = (p: number) => PAD + p * plotW;
  const yToPx = (p: number) => H - PAD - p * plotH;
  const maxCount = Math.max(...bins.map((b) => b.count), 1);
  return (
    <svg width={W} height={H} style={{ background: "#1f2329", borderRadius: 6 }}>
      {/* Grid + axes */}
      {[0, 0.25, 0.5, 0.75, 1.0].map((t) => (
        <g key={t}>
          <line x1={xToPx(t)} y1={PAD} x2={xToPx(t)} y2={H - PAD} stroke="#2b3038" strokeWidth={1} />
          <line x1={PAD} y1={yToPx(t)} x2={W - PAD} y2={yToPx(t)} stroke="#2b3038" strokeWidth={1} />
          <text x={xToPx(t)} y={H - PAD + 14} fill="#6c707a" fontSize="10" textAnchor="middle">{t.toFixed(2)}</text>
          <text x={PAD - 6} y={yToPx(t) + 3} fill="#6c707a" fontSize="10" textAnchor="end">{t.toFixed(2)}</text>
        </g>
      ))}
      {/* Perfect calibration diagonal */}
      <line x1={xToPx(0)} y1={yToPx(0)} x2={xToPx(1)} y2={yToPx(1)} stroke="#ef4444" strokeWidth={1.5} strokeDasharray="4 3" />
      {/* Bin dots, sized by count */}
      {bins.map((b, i) => {
        const r = 3 + 6 * Math.sqrt(b.count / maxCount);
        return (
          <g key={i}>
            <circle
              cx={xToPx(b.mean_predicted)}
              cy={yToPx(b.actual_rate)}
              r={r}
              fill="#22c55e"
              fillOpacity={0.7}
              stroke="#fff"
              strokeWidth={0.5}
            >
              <title>
                {`bin ${(b.bin_lower * 100).toFixed(0)}–${(b.bin_upper * 100).toFixed(0)}%\n` +
                 `predicted ${(b.mean_predicted * 100).toFixed(1)}%  actual ${(b.actual_rate * 100).toFixed(1)}%\n` +
                 `n = ${b.count.toLocaleString()}`}
              </title>
            </circle>
          </g>
        );
      })}
      {/* Axis labels */}
      <text x={W / 2} y={H - 2} fill="#9aa0aa" fontSize="11" textAnchor="middle">Mean predicted probability</text>
      <text x={10} y={H / 2} fill="#9aa0aa" fontSize="11" textAnchor="middle" transform={`rotate(-90 10 ${H / 2})`}>Actual fire rate</text>
    </svg>
  );
}

interface Props {
  open: boolean;
  onClose: () => void;
  activeBaseDate: string;
  predicted: FireFeature[]; // current snapshot (post-province filter)
  observed: FireFeature[]; // all observed features
  liveFires: GistdaFeature[];
  metrics: ValidationMetrics | null;
  thresholds: UrgencyThresholds | null;
  metadata: GeoJsonMetadata | null;
  selectedProvince: string;
  selectedDay: string;
}

// Pop-up with the detail an operator might want before trusting a number on
// the dashboard: training metrics, snapshot composition, urgency thresholds,
// data freshness, etc. Reads everything from already-loaded state — no
// network call.
export default function InfoModal(props: Props) {
  useEffect(() => {
    if (!props.open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") props.onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [props.open, props.onClose]);

  if (!props.open) return null;

  const m = props.metrics ?? {};
  const isBinary = m.task === "binary_fire_in_3d";
  const acc = m.accuracy_within_1day;
  const mae = m.mae_days;
  const rmse = m.rmse_days;
  const r2 = m.r2;

  // Per-tier counts on the current snapshot
  const tiers = { CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0 } as Record<string, number>;
  for (const f of props.predicted) {
    const u = f.properties.urgency_level;
    if (u && u in tiers) tiers[u]++;
  }

  // Per-day counts
  const dayCounts: Record<number, number> = {};
  for (let i = 0; i <= 7; i++) dayCounts[i] = 0;
  for (const f of props.predicted) {
    const d = f.properties.days_until_fire;
    if (d != null && d >= 0 && d <= 7) dayCounts[d]++;
  }

  // Province distribution
  const byProvince: Record<string, number> = {};
  for (const f of props.predicted) {
    const p = (f.properties.province ?? "").trim() || "(unassigned)";
    byProvince[p] = (byProvince[p] ?? 0) + 1;
  }
  const topProvinces = Object.entries(byProvince)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5);

  const fmt = (v: number | undefined, d = 3) =>
    typeof v === "number" && isFinite(v) ? v.toFixed(d) : "—";
  const fmtPct = (v: number | undefined) =>
    typeof v === "number" ? `${(v * 100).toFixed(1)}%` : "—";

  return (
    <div className="info-modal-backdrop" role="dialog" aria-modal="true" onClick={props.onClose}>
      <div className="info-modal" onClick={(e) => e.stopPropagation()}>
        <div className="info-modal-header">
          <h2>Model & Snapshot Details</h2>
          <button className="info-modal-close" onClick={props.onClose} aria-label="Close">
            ×
          </button>
        </div>

        <div className="info-modal-body">
          <section>
            <h3>Held-out test performance</h3>
            {isBinary ? (
              <>
                <p className="info-note" style={{ marginTop: 0, marginBottom: 10 }}>
                  Task: <b>binary classification</b> — "fire within next{" "}
                  {m.imminent_days ?? 3} days?"
                </p>
                <div className="info-grid">
                  <div><span>ROC-AUC</span><b>{fmt(m.roc_auc, 3)}</b></div>
                  <div><span>Avg Precision</span><b>{fmt(m.average_precision, 3)}</b></div>
                  <div><span>Test pos rate</span><b>{fmtPct(m.test_positive_rate)}</b></div>
                  <div><span>ECE (calibration)</span><b>{fmt(m.ece, 4)}</b></div>
                </div>
                <p className="info-note" style={{ marginTop: 4 }}>
                  <b>ROC-AUC</b> วัดคุณภาพ ranking (0.5=สุ่ม, 1.0=perfect).{" "}
                  <b>ECE</b> = Expected Calibration Error — &lt;0.05 หมายถึง probability
                  ที่โมเดลออกมาตรงกับ ground truth (calibrated).{" "}
                  <b>Test pos rate</b> = ภาคจริงมีไฟกี่% — เป็น baseline ของ P@top-K.
                </p>

                {typeof m.stability_auc_mean === "number" && (
                  <>
                    <h4 style={{ marginTop: 16, marginBottom: 6 }}>
                      Stability across {m.stability_valid_months ?? m.stability_months} months
                    </h4>
                    <div className="info-grid">
                      <div><span>AUC mean</span><b>{fmt(m.stability_auc_mean, 3)}</b></div>
                      <div><span>AUC std</span><b>{fmt(m.stability_auc_std, 3)}</b></div>
                      <div><span>AUC min</span><b>{fmt(m.stability_auc_min, 3)}</b></div>
                      <div><span>AUC max</span><b>{fmt(m.stability_auc_max, 3)}</b></div>
                    </div>
                    {m.rolling_by_month && m.rolling_by_month.length > 0 && (
                      <div style={{ marginTop: 6, fontSize: 11, color: "var(--text-3)" }}>
                        Rolling monthly AUC ranges {fmt(m.stability_auc_min, 2)}–{fmt(m.stability_auc_max, 2)};
                        ดูราย script <code style={{ background: "var(--surface-2)", padding: "1px 4px", borderRadius: 3 }}>scripts/rolling_eval.py</code>
                      </div>
                    )}
                  </>
                )}

                <h4 style={{ marginTop: 16, marginBottom: 6 }}>Deployment threshold</h4>
                <div className="info-grid">
                  <div><span>Threshold</span><b>{fmt(m.deployment_threshold, 2)}</b></div>
                  <div><span>Precision</span><b>{fmtPct(m.deployment_precision)}</b></div>
                  <div><span>Recall</span><b>{fmtPct(m.deployment_recall)}</b></div>
                  <div><span>F1</span><b>{fmtPct(m.deployment_f1)}</b></div>
                </div>
                <p className="info-note" style={{ marginTop: 4 }}>
                  Probability cutoff ที่ใช้แปลงเป็น alert/no-alert. ตัวเลขข้างต้น
                  คือ Precision/Recall ณ จุดนี้บน held-out test.
                </p>

                <h4 style={{ marginTop: 16, marginBottom: 6 }}>Watch-list quality (top-K)</h4>
                <div className="info-grid">
                  <div><span>P @ top-5%</span><b>{fmtPct(m.precision_at_top_5pct)}</b></div>
                  <div><span>P @ top-10%</span><b>{fmtPct(m.precision_at_top_10pct)}</b></div>
                  <div><span>P @ top-20%</span><b>{fmtPct(m.precision_at_top_20pct)}</b></div>
                </div>
                {typeof m.uplift_at_top_20pct === "number" && (
                  <p className="info-note" style={{ marginTop: 4 }}>
                    Watch-list lift @top-20%: <b>{m.uplift_at_top_20pct.toFixed(2)}×</b> —{" "}
                    เลือก 20% เสี่ยงสุดที่โมเดลให้คะแนน เจอไฟมากกว่าสุ่มเลือก{" "}
                    {m.uplift_at_top_20pct.toFixed(1)} เท่า
                  </p>
                )}

                {m.reliability_bins && m.reliability_bins.length > 0 && (
                  <>
                    <h4 style={{ marginTop: 16, marginBottom: 6 }}>Reliability curve</h4>
                    <ReliabilityDiagram bins={m.reliability_bins} />
                    <p className="info-note" style={{ marginTop: 4 }}>
                      แต่ละจุด = bin ของ probability โมเดล (X) vs อัตราเกิดไฟจริงในกลุ่มนั้น (Y).
                      ทแยงสีแดง = perfect calibration. ใกล้ทแยง = trustworthy probability.
                    </p>
                  </>
                )}

                <p className="info-note" style={{ marginTop: 12 }}>
                  Evaluated on chronologically held-out 20% test window ({m.evaluated_on ?? "real-distribution"}).
                  Train/val undersample negatives 4:1; test keeps real class balance.
                  Calibration via {m.calibration_method ?? "Platt sigmoid"} fit on val.
                </p>
              </>
            ) : (
              <>
                <div className="info-grid">
                  <div><span>±1 day acc</span><b>{fmtPct(acc)}</b></div>
                  <div><span>MAE</span><b>{fmt(mae, 2)} d</b></div>
                  <div><span>RMSE</span><b>{fmt(rmse, 2)} d</b></div>
                  <div><span>R²</span><b>{fmt(r2, 3)}</b></div>
                </div>
                <p className="info-note">
                  From the held-out final 20% of the chronologically-split training
                  data. The model never saw these rows during tuning or selection.
                </p>
              </>
            )}
          </section>

          <section>
            <h3>Current snapshot · {props.activeBaseDate}</h3>
            <div className="info-grid">
              <div><span>Predicted cells</span><b>{props.predicted.length}</b></div>
              <div><span>Observed (FIRMS)</span><b>{props.observed.length}</b></div>
              <div><span>Live (GISTDA)</span><b>{props.liveFires.length || "—"}</b></div>
              <div><span>Province filter</span><b>{props.selectedProvince === "all" ? "all" : props.selectedProvince}</b></div>
            </div>
          </section>

          <section>
            <h3>Urgency distribution</h3>
            <div className="info-grid">
              <div><span style={{ color: "#dc2626" }}>CRITICAL</span><b>{tiers.CRITICAL}</b></div>
              <div><span style={{ color: "#ea580c" }}>HIGH</span><b>{tiers.HIGH}</b></div>
              <div><span style={{ color: "#f59e0b" }}>MEDIUM</span><b>{tiers.MEDIUM}</b></div>
              <div><span style={{ color: "#10b981" }}>LOW</span><b>{tiers.LOW}</b></div>
            </div>
            {props.thresholds && (
              <p className="info-note">
                Cutoffs: ≤{props.thresholds.CRITICAL.toFixed(1)}d CRITICAL,
                ≤{props.thresholds.HIGH.toFixed(1)}d HIGH,
                ≤{props.thresholds.MEDIUM.toFixed(1)}d MEDIUM,
                ≤{props.thresholds.LOW.toFixed(1)}d LOW.
              </p>
            )}
          </section>

          <section>
            <h3>Predicted day distribution</h3>
            <div className="info-bars">
              {Array.from({ length: 8 }, (_, i) => {
                const count = dayCounts[i];
                const max = Math.max(...Object.values(dayCounts), 1);
                const pct = (count / max) * 100;
                const label = i === 0 ? "Today" : `+${i}d`;
                return (
                  <div key={i} className="info-bar-row">
                    <span className="info-bar-label">{label}</span>
                    <div className="info-bar-track"><div className="info-bar-fill" style={{ width: `${pct}%` }} /></div>
                    <span className="info-bar-count">{count}</span>
                  </div>
                );
              })}
            </div>
          </section>

          {topProvinces.length > 0 && (
            <section>
              <h3>Top 5 provinces by predicted cells</h3>
              <table className="info-table">
                <tbody>
                  {topProvinces.map(([name, count]) => (
                    <tr key={name}>
                      <td>{name}</td>
                      <td><b>{count}</b></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          )}

          <section>
            <h3>Glossary — what these numbers mean</h3>
            <dl className="info-dl">
              {isBinary && (
                <>
                  <dt>ROC-AUC</dt>
                  <dd>Area under the ROC curve. Measures how well the model <b>ranks</b> cells by fire risk regardless of threshold. <b>0.5 = random, 1.0 = perfect, ≥0.8 is good</b>. Robust to class imbalance — the right headline for "rare event" tasks like imminent-fire prediction.</dd>

                  <dt>Average Precision</dt>
                  <dd>Area under the precision-recall curve. More demanding than ROC-AUC when positives are rare. <b>Higher = better</b>; equals the test-set positive rate for a random model.</dd>

                  <dt>Accuracy (binary)</dt>
                  <dd>Share of cells where the model's yes/no answer matches reality, using a 0.5 probability threshold. Easy to read but misleading on imbalanced data — a "say no to everything" baseline scores ~87% here.</dd>

                  <dt>Precision</dt>
                  <dd>Of cells the model flagged as imminent fire, the fraction that really did burn within the window. <b>Higher = fewer false alarms</b>. Reported at the threshold that maximises F1 on the test set.</dd>

                  <dt>Recall</dt>
                  <dd>Of all real imminent fires in the test set, the fraction the model caught. <b>Higher = fewer missed fires</b>. Recall and precision trade off — pick a lower probability threshold to raise recall (more flags, more false alarms).</dd>

                  <dt>F1 score</dt>
                  <dd>Harmonic mean of precision and recall. <b>Best F1</b> is the maximum F1 over all probability thresholds — a single-number summary that balances false alarms against missed fires.</dd>

                  <dt>Best threshold</dt>
                  <dd>Probability cutoff that produced "Best F1". Cells with predicted probability ≥ this threshold are operationally treated as "imminent fire". Lower threshold = more alerts = higher recall, lower precision.</dd>

                  <dt>Precision @ top-K%</dt>
                  <dd>If you take the K% of cells with the highest predicted probability and treat them as your watch-list, what fraction actually burns? <b>Direct measure of watch-list quality</b> — independent of threshold tuning.</dd>

                  <dt>Skill check (binary)</dt>
                  <dd>"Passed" means ROC-AUC ≥ 0.65 — the model meaningfully discriminates fires from non-fires. Below that, predictions are too close to random to act on.</dd>
                </>
              )}
              {!isBinary && (
                <>
                  <dt>±1 day accuracy</dt>
                  <dd>The share of test-set rows where the model's predicted fire date landed within ±1 day of the real fire date. The single most operator-meaningful number: <b>higher = better</b>. 50% means about half the predictions are practically correct.</dd>

                  <dt>MAE (mean absolute error, days)</dt>
                  <dd>Average distance between predicted and real fire dates, in days. <b>Lower = better</b>. MAE = 1.5 means predictions are off by 1½ days on average. Robust to outliers.</dd>

                  <dt>RMSE (root mean squared error, days)</dt>
                  <dd>Like MAE but squares the errors before averaging, so big misses count more. <b>Lower = better</b>. If RMSE is much higher than MAE, a few large errors dominate the picture.</dd>

                  <dt>R² (coefficient of determination)</dt>
                  <dd>How much variance in the real fire dates the model explains. <b>0 = no better than predicting the mean, 1 = perfect, negative = worse than predicting the mean</b>. Wildfire date is inherently noisy, so even R² ≈ 0.3 is useful.</dd>

                  <dt>Skill check</dt>
                  <dd>"Passed" means the model beats the predict-mean baseline by ≥5% on test MAE. "Failed" means the model is barely better than guessing the average — investigate before trusting predictions.</dd>
                </>
              )}

              <dt>Validation MAE vs Test MAE</dt>
              <dd>Validation is the slice used during hyperparameter tuning; test is the held-out final 20% the model has never seen. If validation is dramatically worse than test, the validation window was unusually hard (often: off-peak fire season).</dd>

              <dt>Urgency tiers (CRITICAL / HIGH / MEDIUM / LOW)</dt>
              <dd>Buckets of <code>days_until_fire</code>: CRITICAL = fire today, HIGH ≤ 2 days, MEDIUM ≤ 4 days, LOW ≤ 7 days. Used for at-a-glance prioritisation; thresholds are listed under "Urgency distribution" above.</dd>

              <dt>days_until_fire (the model's actual output)</dt>
              <dd>An integer 0–7 returned per grid cell — "the model thinks this cell will burn N days from the base date". 0 = today, 7 = end of the prediction horizon.</dd>

              <dt>raw_prediction</dt>
              <dd>The continuous version of <code>days_until_fire</code> before flooring to an integer. Floor (not round) is used so a value of 0.96 lands on day 0 ("within 24h"), matching how operators read the bucket label.</dd>

              <dt>Confidence (rounding proxy)</dt>
              <dd>How close the raw prediction landed to the centre of its day-bucket: 1.0 = dead-centre, 0 = at the edge. <b>Not a calibrated probability</b> — don't read 0.80 as "80% chance the fire happens".</dd>

              <dt>Historical fires (last 30 days, FIRMS)</dt>
              <dd>Literal count of NASA FIRMS hotspot detections in the cell over the last 30 days. Used as a sanity-check: a CRITICAL prediction in a cell with 0 recent fires deserves scepticism.</dd>

              <dt>Hit rate vs FIRMS</dt>
              <dd>For each historical prediction, did the predicted cell actually burn within ±1 day of the predicted date? Higher = the dashboard is calling real events, not noise.</dd>
            </dl>
          </section>

          <section>
            <h3>Data sources</h3>
            <ul className="info-list">
              <li><b>NASA FIRMS VIIRS NRT</b> — hotspot detections + FRP / brightness, used for training labels and historical aggregates.</li>
              <li><b>GISTDA NRT VIIRS + MODIS</b> — independent hotspot feed from Thailand's national space agency, optional live overlay.</li>
              <li><b>Open-Meteo ERA5</b> — daily reanalysis (temp / precip / wind), used as features only when the weather cache is present.</li>
              <li><b>Hansen GFC v1.11</b> — per-cell tree cover baseline (2000) + recent loss %, distinguishes wildfire risk from agricultural-burn signal.</li>
            </ul>
            <p className="info-note">
              All values shown anywhere in the dashboard come from real sources — no synthetic, interpolated, or simulated data.
            </p>
          </section>

          <section>
            <h3>Selected filter</h3>
            <p className="info-note">
              Day filter: <b>{props.selectedDay === "all" ? "all" : `+${props.selectedDay}d`}</b> · Province: <b>{props.selectedProvince === "all" ? "all" : props.selectedProvince}</b>
            </p>
          </section>
        </div>
      </div>
    </div>
  );
}
