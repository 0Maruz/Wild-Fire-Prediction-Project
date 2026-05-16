# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

Wildfire **imminence** prediction for Thailand (BBOX `96,4,107,22`). A LightGBM binary classifier answers *"will a fire occur in this 0.1° cell within the next 3 days?"* and outputs a probability. The probability is converted to a pseudo-days value (1–7) via a monotone mapping at inference time so the existing CRITICAL/HIGH/MEDIUM/LOW tier logic in `risk_map.py` keeps working unchanged.

### Why binary, not regression
Regression with MAE/MSE objectives consistently collapsed predictions toward the median (~3–4 days) — the available features (FIRMS hotspots + partial ERA5 weather) lack the signal needed to distinguish "fire in 1 day" from "fire in 7 days". Multiclass softmax did the same at probability scale. Binary "fire-in-3-days" is the framing the features can support — held-out test AUC ≈ 0.84 and the model meaningfully ranks cells. **Do not reintroduce regression or multiclass.**

### Hard rule: real data only
Every feature must come from a measurable source. Pipeline consumes:
- **NASA FIRMS VIIRS NRT** (required) — hotspots; powers fire/FRP/brightness/confidence + spatial-neighbor features.
- **Open-Meteo Archive API** (optional, no key) — real ECMWF ERA5 daily reanalysis. Activate via `python fetch_weather.py`. Cached to `data/weather/weather_cache.parquet`.
- **Hansen GFC** (optional, run-once) — tree cover baseline + recent loss via `python fetch_treecover.py`.
- **Calendar** — derived from each row's real date.

No synthetic / simulated / interpolated values. If a real source isn't available for a column, the column is simply not in `FEATURES`. Don't introduce fabricated defaults — when something is missing, it's missing.

## Common commands

Python entry points use bare imports (`from features import FEATURES`) so they must run from inside `src/`:

```bash
# 1. Pull latest VIIRS NRT hotspots → data/firms/firms_all.parquet
cd src && python fetch_firms.py [--days 1-10]

# 1b. (OPTIONAL) Pull ERA5 weather (idempotent; resume on rerun)
cd src && python fetch_weather.py [--start YYYY-MM-DD] [--end YYYY-MM-DD] [--limit-cells N] [--quiet-hours 2-8]

# 1c./1d. (OPTIONAL, not wired into training) GISTDA hotspots / LULC polygons
cd src && python fetch_gistda_hotspots.py
cd src && python fetch_gistda_lulc.py    # run-once

# 2. Train (load → features → undersample → tune → ensemble → eval → persist)
cd src && python train.py [--n-iter 30] [--n-splits 5] [--n-ensemble 5]
#                          [--quick]   ← n_iter=12, n_splits=3 (~20 min on a laptop)
#                          [--fast]    ← n_iter=20, n_splits=3

# 3. Regenerate the GeoJSON map without retraining
cd src && python risk_map.py

# 4. Serve the API + SPA on :8000
cd src && uvicorn api:app --reload

# OR: end-to-end orchestrator at project root
./run.sh [--fresh] [--weather] [--quick|--fast] [--no-train] [--predict-only]
```

Frontend (React SPA) — rebuild after editing `web/src/`:
```bash
cd web
./node_modules/.bin/tsc -b           # type-check
./node_modules/.bin/vite build       # → web/dist/ (served by api.py at /)
```
**`frontend/` is a legacy vanilla-JS dashboard kept only for historical reference — do not edit it.** The React app in `web/src/` is what the FastAPI server serves.

Dependencies: `pip install -r requirements.txt` into `.venv/`. Requires `.env` with `FIRMS_API_KEY` (see `.env.example`). `scikit-optimize` and `matplotlib` are optional — train.py falls back gracefully if missing (RandomizedSearchCV instead of BayesSearchCV; PNG report skipped).

There is no Python test suite, linter, or build step.

## Architecture

### Module layout (in `src/`)

| File | Role |
|---|---|
| `fetch_firms.py` | Pulls VIIRS NRT hotspots from NASA FIRMS with retry/backoff. Accumulative parquet. |
| `fetch_weather.py` | Real ERA5 daily aggregates from Open-Meteo Archive. Idempotent, checkpoints, retries failed batches. Optional quiet-hours wait window. |
| `fetch_treecover.py` | Hansen GFC `treecover2000` + `lossyear` rasters → per-cell 0.1° aggregates. |
| `fetch_gistda_*.py` | GISTDA hotspots / LULC. Not wired into training yet. |
| `io_utils.py` | Format-agnostic table I/O — dispatches on `.csv` ↔ `.parquet`. **Use these instead of `pd.read_csv` / `pd.to_csv`** so files stay swappable. |
| `data_loader.py` | Schema-validated load + clean + grid snap + daily aggregation + densification + urban filter + optional weather/tree-cover merge. |
| `urban_areas.py` | Curated ~40 Thai urban centers with hand-tuned exclusion radii. Used at training (drop hotspots) and inference (drop predictions + annotate nearest city). |
| `thailand_boundary.py` | 77-province GeoJSON merged → `is_in_thailand()` country mask + `find_province()` per-cell annotation. |
| `features.py` | Lag/rolling/calendar/spatial-neighbor/streak features. Owns `FEATURES_CORE` + `FEATURES_WEATHER`. Every rolling window applies `.shift(1)` BEFORE `.rolling()` (past-only — see `# CAUSAL` comments). |
| `model.py` | **Legacy from the multi-model era.** train.py no longer uses its `select_best` / multi-candidate helpers; the binary classifier path is self-contained in train.py. Kept around because some tools still import `evaluate()` / `EnsembleRegressor`. |
| `train.py` | End-to-end binary classifier pipeline (see "Training pipeline" below). |
| `risk_map.py` | Loads model + features, predicts for latest base date, filters (history / urban / country / per-day cap), assigns urgency tiers, writes `outputs/riskmap/fire_dates_all.geojson` (append-mode). |
| `api.py` | FastAPI: `/predictions/today`, `/predictions/timeline`, `/predictions/day/{n}`, `/predict/location`, `/metrics`, `/geojson`. Mounts `web/dist/` at `/` so SPA + API share port 8000. |

### Pipeline

```
data/raw/*.parquet ─┐
                    ├─► data_loader ─► features ─► train.py ─► outputs/models/lgbm_fire_date_model.pkl
data/firms/        ─┘    (densify)    (CAUSAL                       │
firms_all.parquet                      lag/roll)                    ▼
                                                            outputs/features/full_features.parquet
                                                            outputs/metadata/dataset_info.json
                                                                       │
                                                                       ▼
                                                                risk_map.py
                                                                       │
                                                                       ▼
                                                outputs/riskmap/fire_dates_all.geojson
                                                                       │
                                                       ┌───────────────┴───────────────┐
                                                       ▼                               ▼
                                                    api.py                    web/src/* → web/dist/
                                                  (FastAPI)            (React SPA fetches /geojson)
```

### Training pipeline (binary classifier, memory-frugal)

`train.py` is self-contained — it does **not** use `model.py`'s multi-candidate helpers. Flow:

1. **Load + features** — `load_and_prepare` → `build_features`. Output: ~4.4M rows × ~134 features (or ~164 with weather), densified across active cells × full date range.
2. **Memory-frugal label + downcast** — drop unused columns, cast features to **float32** (halves RAM), build binary label `y = (days_until_fire ∈ {1..IMMINENT_DAYS=3})`.
3. **Undersample negatives globally** — keep all positives (~5%) + random sample of negatives at `NEG_TO_POS_RATIO=4`. ~4.4M → ~1.2M rows. **Done before the split** so the full-densified frame never lives in memory through the split (a prior run OOM'd at ~12 GB precisely there). Then `del feats; gc.collect()`.
4. **Chronological 60/20/20 train/val/test split** by date.
5. **Sample weights** — recency decay (halflife 45 d) × inverse class frequency × gentle 1.5×/1.3×/1.1× boost on days 1/2/3-5. Heavier boosting (used in earlier runs) destabilized the model.
6. **LightGBM tuning** — `BayesSearchCV` (or `RandomizedSearchCV` fallback) with `TimeSeriesSplit(n_splits, gap=7)`, `scoring="roc_auc"`. `scale_pos_weight = neg_count / pos_count` corrects residual imbalance. **Outer CV `n_jobs=1`, inner LGBM `n_jobs=-1`** — setting both to -1 spawns cores² threads and load average pegs at ~50 (each fit 4–5× slower).
7. **Ensemble refit on train+val** — `n_ensemble=3..10` LGBM models with different seeds at best hyperparameters. Early stopping uses the tail 10% of train+val as `eval_set`, `eval_metric=["binary_logloss", "auc"]`. Wrapped in `_EnsembleRegressor`.
8. **Test evaluation** — binary metrics (ROC-AUC, average precision, accuracy, precision, recall, F1, P@top-K%) at the default 0.5 threshold AND at the F1-optimal threshold (descriptive only, not deployed).
9. **Persist** — `outputs/models/lgbm_fire_date_model.pkl` + `outputs/models/history/{UTC_TIMESTAMP}_lightgbm.pkl` + `outputs/metadata/dataset_info.json` + matplotlib PNG report.
10. **risk_map.run()** is called at the end to refresh the GeoJSON.

### `_EnsembleRegressor` — the inference contract risk_map.py and api.py rely on

The ensemble class in train.py is named `_EnsembleRegressor` for historical reasons; it wraps **binary classifiers**.

- `predict_proba(X)` → 1-D `np.array` of `P(fire in next 3 days)` averaged across the ensemble.
- `predict(X)` → 1-D pseudo-days array via `_prob_to_days_for_compat`: `days = 1 + (1 − prob) × 6`. Monotone (`prob=1.0 → day 1`, `prob=0.5 → day 4`, `prob=0.0 → day 7`). risk_map.py / api.py call only `.predict()` and don't know the model is binary.
- `feature_importances_` → averaged across ensemble.

**Changing this mapping shifts the dashboard's CRITICAL/HIGH/MEDIUM/LOW share** — the tier counts are a function of how aggressively probability maps to short pseudo-days.

### Densification (required for correctness)

`data_loader.densify_active_cells()` expands the sparse hotspot frame into a dense (active-cell × every-day-in-range) grid, no-fire days filled with zeros. This is what makes lag features (`fire_lag_1` = literally yesterday) and rolling windows (`fire_sum_7d` = past 7 calendar days, past-only) correct. Inactive cells (zero fires ever) are excluded — no signal.

### CAUSAL feature audit (don't break)

`features.py` has a strict no-future-data rule:
- Every rolling window uses `_past_roll()`, which applies `.shift(1)` **before** `.rolling()`. Today's value is excluded from past aggregates.
- Every lag is `.shift(lag)` with `lag >= 1`.
- Trend features are `lag_1 − lag_k`, not `today − shift(k)`.
- Streak counters use shifted fire flags.
- Every feature has a `# CAUSAL` comment marking it audited.

The label `days_until_fire` is computed strictly from FUTURE rows, so any feature that accidentally touches future data is label leakage. **Do not move features to "today" data without re-auditing the label construction.**

### Feature contract

- `FEATURES_CORE` (~134 cols) — always present.
- `FEATURES_WEATHER` (~30 cols) — only emitted when ERA5 weather is present in the daily frame. Auto-dropped at training time when coverage falls below `MIN_WEATHER_COVERAGE` (default 20%) — sparse weather is more harmful than absent weather.
- `resolve_features(df)` → subset actually present.
- **`dataset_info.json["features"]` is the persisted contract** — risk_map.py / api.py prefer this list at runtime. Don't hardcode feature lists in those files.

If you add or remove features, delete `outputs/models/*.pkl` before retraining or the resolver will silently mispredict.

### Urgency thresholds + risk_map filtering

`train.py` persists fixed-domain cutoffs (`CRITICAL=0, HIGH=2, MEDIUM=4, LOW=7`) into `dataset_info.json["urgency_thresholds"]`. Under the binary→pseudo-days mapping, probabilities ≈ 0.83 land on day 1 (CRITICAL), ≈ 0.5 on day 4 (MEDIUM).

risk_map.py applies a **fixed-then-quantile fallback**: if the fixed scheme would collapse every cell into one tier (model output band < 1 day), it falls back to per-snapshot 25/50/75 quantile thresholds. The frontend detects this and shows a "Quantile mode" note.

risk_map.py then runs four filters and persists the funnel:
1. **History** — min 3 fires in last 30d, min 3 in last 90d, min 3 fire-days/year. Cells failing all three are dropped (climatology-dominated).
2. **Urban** — drop cells inside curated city polygons + annotate `nearest_urban_area`.
3. **Country** — drop cells outside Thailand's land border (training data spans the full BBOX so the model learns regional patterns; the dashboard is Thailand-focused).
4. **Per-day cap** — within each predicted day, sort by `historical_fire_count_30d × 1000 + rounding_proximity` and keep top `MAX_CELLS_PER_DAY` (default 100). Set `MAX_CELLS_PER_DAY=0` to disable.

### Frontend (React SPA in `web/`)

- `App.tsx` — top-level; fetches `/geojson` via relative path so the SPA can be served by any backend that mounts the GeoJSON.
- `components/MapView.tsx` — Leaflet map, predicted/observed/live-fire layers, marker popups. The predicted-cell popup shows **probability %** (recovered via `prob = 1 − (raw_pred − 1) / 6`) + a Thai risk-tier headline + ground-truth-anchored interpretation ("≈ ใน 10 cell ระดับนี้ ~3 เกิดไฟใน 3 วัน").
- `components/AccuracyHero.tsx` — operator-facing performance card. Headline is **Recall** (e.g. 97%) = "of fires that actually happened, what fraction did we catch?". Sub-stats: letter grade A–D from ROC-AUC, uplift vs random (P@top-20% / `test_positive_rate`), false alarm rate, watch-list precision. All technical metrics live in InfoModal. Detects task via `metrics.task === "binary_fire_in_3d"` with a legacy regression fallback view.
- `components/InfoModal.tsx` — glossary modal, task-type-aware metric definitions.
- `components/Sidebar.tsx` — base-date / province filters, day selector, hit-rate, land-cover breakdown, CSV export.
- `types.ts` — TypeScript shapes mirroring what risk_map writes. `ValidationMetrics` includes both legacy keys (`mae_days`, `accuracy_within_1day`) and binary keys (`roc_auc`, `f1`, `precision_at_best_thr`, ...).

The legacy regression keys in `test_metrics` look terrible (MAE ~5 d, acc±1 ~6%) because they're computed on pseudo-days output, not real days. **Don't report them as the model's quality**. Always check `task` first.

### Path resolution & env

All entry points resolve paths via `BASE_DIR = parent-of-src`. `train.py` reads `.env` and resolves relative env values against `BASE_DIR`. Absolute paths pass through.

| Var | Default | Purpose |
|---|---|---|
| `FIRMS_API_KEY` | (required) | NASA FIRMS map key |
| `RAW_DIR` | `./data/raw` | Bulk archive of historical FIRMS exports |
| `FIRMS_PATH` | `./data/firms/firms_all.parquet` | NRT cache |
| `OUTPUT_DIR` | `./outputs` | Models / features / metadata / geojson |
| `GRID_SIZE` | `0.1` | Lat/lon snap resolution in degrees |
| `URBAN_FILTER_ENABLED` | `true` | Drop urban hotspots at training and inference |
| `URBAN_BUFFER_KM` | `0` | Extra km beyond each city's hand-tuned radius |
| `COUNTRY_FILTER_ENABLED` | `true` | Drop predicted cells outside Thailand at risk_map time |
| `STALE_WARN_DAYS` | `5` | Warn when latest FIRMS observation is older |
| `MIN_WEATHER_COVERAGE` | `0.20` | Below this, training auto-drops weather columns |
| `MIN_HISTORICAL_FIRES_FOR_DISPLAY` | `3` | risk_map filter: min fires in last 30d |
| `MIN_LONG_HISTORICAL_FIRES` | `3` | risk_map filter: min fires in last 90d |
| `MAX_CELLS_PER_DAY` | `100` | risk_map per-day cap; 0 disables |
| `MIN_FIRE_DAYS_PER_YEAR` | `3.0` | risk_map filter: annualized fire-day rate floor |
| `MAX_TRAIN_HISTORY_DAYS` | `0` | If >0, train.py keeps only this many latest days of densified data |

### Gotchas

- **OOM during training** = you didn't downsample before split (memory-frugal step in train.py STEP 3), didn't cast to float32, or `n_ensemble` too high. Recipe: undersample first → cast to float32 → split → ensemble ≤ 5 on a 22 GB laptop.
- **Tuning hangs / extreme load average** = `n_jobs=-1` on both BayesSearchCV outer AND LGBM inner spawns cores² threads. Keep outer `n_jobs=1` (sequential CV folds, parallelism inside the fit).
- **Test metrics look terrible (MAE 5 d, acc±1 6%)** = you're reading legacy regression keys from `test_metrics` on a binary task. Read `roc_auc`, `f1`, `precision_at_best_thr` instead; check `test_metrics.task` first.
- **All predictions land in MEDIUM/LOW, no CRITICAL/HIGH** = the binary classifier's probabilities are mostly 0.3–0.5 (uncertain), which under the pseudo-days mapping land in days 4–5. To get more CRITICAL alerts, either improve features (weather completion, drought index) or tune `_prob_to_days_for_compat()`.
- **`fetch_firms.py` HTTP 400 across all datasets** = bad / rate-limited `MAP_KEY`. Check status at `https://firms.modaps.eosdis.nasa.gov/mapserver/mapkey_status/?MAP_KEY=…`. Resets daily.
- **`uvicorn api:app` startup `RuntimeError: Model not found`** = no trained artifact. Run `python train.py` first.
- **Stale model after feature changes**: delete `outputs/models/*.pkl` before retraining. api.py / risk_map.py resolve features from `dataset_info.json` but a leftover `.pkl` from a different feature contract will silently mispredict.
- **`scikit-optimize` / `matplotlib` missing**: train.py falls back to `RandomizedSearchCV` / skips PNG report. Install for full functionality: `pip install scikit-optimize matplotlib scipy`.
- **`PerformanceWarning: DataFrame is highly fragmented`** during feature build is harmless — pandas warns about column-by-column `frame.insert` calls.
- **Open-Meteo 429s**: archive endpoint is per-hour and per-day rate-limited. `fetch_weather.py` is idempotent — rerun resumes. Optional `OPEN_METEO_QUIET_HOURS=2-8` (or `--quiet-hours 2-8`) waits for an off-peak window.
- **`./run.sh` ends with `exec uvicorn`** — it never returns. Use `--no-train` to skip retraining and just serve.
- **`frontend/` directory is legacy** — vanilla JS dashboard from a previous version. Edit `web/src/` instead.
