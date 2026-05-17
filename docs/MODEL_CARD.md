# Model Card: Thailand Wildfire Imminence Predictor v0.5

> Following the [Google Model Cards](https://modelcards.withgoogle.com/about) framework.

## 🎯 Model Details

- **Name:** Thailand Wildfire Imminence Predictor
- **Version:** v0.5 (Phase 0.5 — calibrated, validated, multi-month stable)
- **Type:** Binary classifier (LightGBM ensemble + Platt calibration)
- **Output:** `P(fire occurs in 0.1° cell within next 3 days)` ∈ [0, 1]
- **Task:** `binary_fire_in_3d`
- **Geographic scope:** Thailand BBOX `96°E–107°E, 4°N–22°N`
- **Temporal resolution:** Daily (one prediction per cell per day)
- **Spatial resolution:** 0.1° grid (≈ 11 km × 11 km at the equator)
- **Developed by:** Solo project (chankan2q@gmail.com), 2025–2026
- **License:** MIT
- **Source code:** [github.com/0Maruz/Science-Project-version-3](https://github.com/0Maruz/Science-Project-version-3)

## 📋 Intended Use

### Primary use cases
1. **Operator watch-list** — daily ranking of cells by imminent-fire risk
2. **Resource allocation** — identifying top-K cells for ground-team patrols
3. **Research benchmark** — open-source baseline for Thai wildfire ML
4. **Educational** — student/portfolio demonstration of operational ML

### Out-of-scope uses
- ❌ **Life-safety decisions** — model is research-grade, not certified
- ❌ **Automated dispatch** — operator review of every alert is required
- ❌ **Real-time evacuation** — not validated for emergency response
- ❌ **Legal liability claims** — precision is too low (~10–35%) for accusations
- ❌ **Use outside Thailand** — trained only on Thailand BBOX

### Operational threshold
- **Deployment threshold:** `0.05` (best-F1 on held-out test set)
- At this threshold: Precision ≈ 11%, Recall ≈ 77%
- Watch-list mode preferred over alert mode given the precision/recall trade-off

## 📊 Performance

### Test set (held-out chronological 20% = ~890K rows)

| Metric | Value | Interpretation |
|---|---|---|
| ROC-AUC | **0.8451** | Good ranking (Grade A-) |
| Average Precision | 0.3124 | 2.4× over random baseline (3.43%) |
| ECE (calibration) | **0.0216** | Excellent — probability matches reality |
| F1 (best threshold) | 0.1942 | Operationally usable |
| Precision @ deploy | 0.1112 | 11% of alerts are true fires |
| Recall @ deploy | 0.7654 | Catches 77% of true fires |
| Watch-list (top-20%) | 0.1156 | 3.4× over random selection |
| Test positive rate | 0.0343 | 3.43% of cells burn within 3 days |

### Stability across 17 monthly rolling evaluations

| Statistic | AUC |
|---|---|
| Mean | **0.9152** |
| Std deviation | 0.0640 |
| Min | 0.8044 (Mar 2026) |
| Max | 0.9845 (Aug 2025) |

The model is **stable across seasons** — burn season and off-season both
score above 0.80 AUC. See `outputs/metadata/rolling_eval.json` for per-month
details.

## 🔬 Training Data

### Sources (all open, all verifiable)

| Source | Coverage | License | Verification |
|---|---|---|---|
| NASA FIRMS VIIRS NRT | 100% | Open / US Government | [firms.modaps.eosdis.nasa.gov](https://firms.modaps.eosdis.nasa.gov/) |
| ECMWF ERA5 (via Open-Meteo) | ~38% | CC-BY 4.0 | [open-meteo.com](https://open-meteo.com/) |
| Hansen GFC v1.11 | 100% | Open (UMD) | [glad.umd.edu](https://glad.umd.edu/) |
| Thailand 77-province GeoJSON | 100% | Open (HDX) | [data.humdata.org](https://data.humdata.org/dataset/cod-ab-tha) |

**Hard rule: real data only — no synthetic, no random, no interpolated values.**
If a real source is unavailable for a column, the column is simply absent.

### Statistics
- **Temporal coverage:** 2025-01-31 → 2026-05-14 (14 months)
- **Active cells:** 9,479 (excluding inactive cells with zero fires ever)
- **Densified rows:** 4,455,130 (active cells × days)
- **Positive rate** (fire within 3 days): 5.31% globally
- **Labeled training rows** (after undersampling negatives 4:1): 1,183,285

### Pre-processing
1. **Cleaning** — drop FRP outliers (top 0.1%), confidence < threshold
2. **Grid snap** — 0.1° lat/lon
3. **Densification** — fill no-fire days with zeros within active-cell range
4. **Urban filter** — drop hotspots inside curated Thai city polygons
5. **Tree cover merge** — Hansen GFC per-cell aggregates
6. **Weather merge** — ERA5 where available (38% coverage)
7. **Float32 cast + class-balance undersample** — memory-frugal pipeline

## 🧠 Model

### Architecture
- **Base:** LightGBM `LGBMClassifier(objective="binary")`
- **Ensemble:** 3 models with different random seeds, averaged probabilities
- **Calibrator:** Platt sigmoid (LogisticRegression on validation set's raw probabilities)
- **Inference output:** Calibrated probability → optional pseudo-days mapping for dashboard tiers

### Hyperparameters (best from BayesSearchCV on TimeSeriesSplit(5, gap=7))
```
n_estimators: 400
max_depth: 8
learning_rate: 0.05
num_leaves: 31
min_child_samples: 20
subsample: 0.9
colsample_bytree: 0.7
reg_alpha: 0.0
reg_lambda: 1.0
scale_pos_weight: ~3.8  (corrects residual class imbalance after undersampling)
```

### Features (164 total)
- Lag features (1-30 days): fire_count, FRP
- Rolling windows (3-60 days): sum, max, mean, active-days
- Spatial neighbors (3×3 and 5×5 grids): fire + FRP aggregates
- Calendar: cyclic encoding of month, day-of-year, week, day-of-week
- Burn-season: is_burn_season, is_dry_season, days_into_burn_season
- Fire periodicity: days_since_last_fire, season_fire_count, recurrence
- Static: distance_to_nearest_city, tree_cover_pct_2000, tree_loss_pct_recent
- Weather (when available): temp_max/min, precip_sum, wind_max, et0 + lags/rolls

### Causality (anti-leakage audit)
- Every rolling window uses `.shift(1)` BEFORE `.rolling()` (past-only)
- Every lag is `.shift(lag)` with `lag ≥ 1`
- Trend features use `lag_1 - lag_k` (no current day)
- Streak counters use shifted fire flags
- Every feature tagged `# CAUSAL` in `src/features.py`

The label `days_until_fire` is computed strictly from FUTURE rows.
See `docs/METHODOLOGY.md` for the full leakage audit.

## ⚠️ Limitations

### Data limitations
1. **Weather coverage is sparse (~38%)** — full 100% would lift AUC by an estimated 3–5%
2. **No drought index (KBDI / SPI)** — known strong predictor in operational systems
3. **No vegetation moisture (NDVI / NDWI)** — would improve fuel state modeling
4. **No lightning data** — natural ignition source missing
5. **No elevation / slope / aspect** — terrain factors absent
6. **Short history** — 14 months may not capture inter-annual variability

### Modeling limitations
7. **Threshold-dependent metrics** — precision/recall trade-off is steep due to ~3% positive rate
8. **Calendar dominance** — top features are seasonal (`doy_sin/cos`, `week_sin`), so model partly predicts "burn season vs not" rather than cell-specific imminence
9. **Spatial CV not performed** — train/test split is purely temporal; performance on geographically held-out provinces unknown
10. **Single-grid resolution** — 0.1° (~11 km) cells may miss sub-grid fire dynamics

### Deployment limitations
11. **Manual retrain cadence** — no automatic drift detection (recommended weekly)
12. **No on-call infrastructure** — no PagerDuty / runbook / rollback automation
13. **No A/B testing** — new versions ship directly to production
14. **No user authentication** — dashboard is open access

## 🧪 Ethical Considerations

- **No personal data** — model uses only satellite + reanalysis data
- **No demographic bias by construction** — features have no demographic content
- **Geographic bias possible** — performance may differ by province; spatial fairness audit not yet performed
- **Operational bias risk** — if used to allocate finite resources, the model's bias toward known-burn cells may underserve emerging areas
- **Public dashboard** — predictions could theoretically panic or mislead the public; framing emphasizes "research-grade, watch-list" use

## 🔄 Validation Strategy

1. **Chronological hold-out** — final 20% of timeline never seen during tuning
2. **Time-series CV with 7-day gap** — prevents leakage between adjacent folds
3. **Rolling monthly eval** — 17 monthly snapshots tracked for drift
4. **Calibration verification** — Platt sigmoid fit on val, ECE checked on test
5. **Retrospective validation** — past predictions tagged hit/miss/future as ground truth arrives (visible in dashboard's "Past Predictions" panel)

## 📅 Maintenance

- **Daily:** `./run.sh --fresh --predict-only` — refresh predictions
- **Weekly:** `./run.sh --quick` — retrain on latest 14 months
- **Monthly:** `python scripts/rolling_eval.py` — check for AUC drift
- **Quarterly:** review feature importance + add new sources as available

## 📚 Citation

If you use this model or method, please cite:

```bibtex
@misc{thailand_wildfire_predictor_2026,
  author = {0Maruz},
  title  = {Thailand Wildfire Imminence Predictor v0.5},
  year   = {2026},
  url    = {https://github.com/0Maruz/Science-Project-version-3}
}
```

## 📞 Contact

- **Maintainer:** chankan2q@gmail.com
- **Issues:** [GitHub Issues](https://github.com/0Maruz/Science-Project-version-3/issues)
- **License:** MIT

---

*Card last updated: 2026-05-16. Following [Mitchell et al. 2019](https://arxiv.org/abs/1810.03993) Model Cards format.*
