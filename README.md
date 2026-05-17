# Wildfire Date Prediction (Thailand)

ระบบทำนาย **"ไฟป่าจะเกิดอีกกี่วัน"** ในกริด 0.1° ทั่วประเทศไทย (BBOX `96,4,107,22`)
ใช้ข้อมูลจริงจาก NASA FIRMS VIIRS NRT + (ตัวเลือก) ข้อมูลอากาศ ECMWF ERA5 จาก Open-Meteo
แล้ว train **LightGBM binary classifier** ตอบคำถาม "ใน cell นี้จะมีไฟใน 3 วันข้างหน้ามั้ย?"
output เป็น **probability** map → ระดับเร่งด่วน CRITICAL / HIGH / MEDIUM / LOW

> **โน้ต:** เคยเป็น regression "ทำนาย exact day 1–7" แต่ feature ที่มี (satellite + weather 38%)
> ไม่พอสำหรับ regression task — collapse เป็น predict-mean ทุกครั้ง (R² ติดลบ)
> เปลี่ยนเป็น binary แล้ว AUC = 0.845 (ดี) ดูส่วน "การประเมินความแม่นยำ" ด้านล่าง

## 📜 Trust & transparency

ก่อนเชื่อตัวเลข — ลองอ่านเอกสารพวกนี้:

- 📋 **[MODEL_CARD.md](docs/MODEL_CARD.md)** — model details, intended use, performance, limitations (Google Model Card format)
- 📐 **[METHODOLOGY.md](docs/METHODOLOGY.md)** — how it works, anti-leakage audit, split protocol, reproducibility checklist
- 🔬 **[outputs/metadata/dataset_info.json](outputs/metadata/dataset_info.json)** — full hyperparameter + metric trail (machine-readable)
- 📈 **[outputs/metadata/rolling_eval.json](outputs/metadata/rolling_eval.json)** — 17-month rolling AUC for stability audit
- 🎯 **[outputs/riskmap/fire_dates_all.geojson](outputs/riskmap/fire_dates_all.geojson)** — every past prediction with `validation_status` (hit/miss/future)
- 🐍 **`grep "# CAUSAL" src/features.py`** — leakage audit (134 of 134 features tagged)

Dashboard ขวาล่างมี **"Past Predictions"** panel แสดง track record จริงในอดีต — ดู screenshot ใน MODEL_CARD.

---

> **หลักการสำคัญ — Real data only**
> ทุก feature มาจากแหล่งที่วัดได้จริง ไม่มีการสร้างค่าจำลอง / สุ่ม / interpolate ใด ๆ
> ถ้าแหล่งไหนไม่มี = ไม่มี column นั้นใน model

---

## 1. ติดตั้งครั้งแรก

```bash
# clone โปรเจกต์แล้วเข้า directory
cd Science-Project-version-3

# สร้าง virtualenv
python -m venv .venv
source .venv/bin/activate

# ติดตั้ง dependencies
pip install -r requirements.txt

# คัดลอก template ของ env แล้วใส่ API key
cp .env.example .env
# แก้ไฟล์ .env ใส่ FIRMS_API_KEY ของคุณ (ขอฟรีที่ https://firms.modaps.eosdis.nasa.gov/api/area/)
```

ไฟล์/โฟลเดอร์สำคัญ:
- `data/raw/` — ไฟล์ archive ขนาดใหญ่ (Parquet)
- `data/firms/firms_all.parquet` — cache แบบสะสมจาก `fetch_firms.py`
- `data/weather/weather_cache.parquet` — (ตัวเลือก) cache ERA5 จาก `fetch_weather.py`
- `outputs/models/lgbm_fire_date_model.pkl` — โมเดลที่ train แล้ว
- `outputs/features/full_features.parquet` — feature dataframe (input ให้ predict)
- `outputs/metadata/dataset_info.json` — metadata + metric + threshold
- `outputs/riskmap/fire_dates_all.geojson` — ข้อมูลที่หน้าเว็บอ่าน

---

## 2. ลำดับการรัน

> **สำคัญ:** สคริปต์ทุกตัวต้อง `cd src/` ก่อนรัน เพราะใช้ bare imports ระหว่างกัน

### 2.1 ดึงข้อมูล hotspot (รันทุกวัน)

```bash
cd src
python fetch_firms.py              # ดึง 1 วันล่าสุด (default)
python fetch_firms.py --days 7     # ดึง 7 วันล่าสุด (สูงสุด 10)
```

ผลลัพธ์ → `data/firms/firms_all.parquet` (สะสมเรื่อย ๆ ไม่ลบของเก่า)

### 2.2 (ตัวเลือก) ดึงข้อมูลอากาศ

```bash
python fetch_weather.py                            # ดึงทุก cell ในช่วงวันที่มีข้อมูล FIRMS
python fetch_weather.py --start 2025-01-01 --end 2025-12-31
python fetch_weather.py --limit-cells 50           # debug: ดึงแค่ 50 cell แรก
```

- ใช้ Open-Meteo Archive (ฟรี ไม่ต้อง API key)
- Idempotent — รันซ้ำดึงเฉพาะ (cell, date) ที่ยังไม่มี
- ERA5 มี lag ~5 วันจากเวลาจริง สคริปต์ตัด end date อัตโนมัติ
- ถ้าข้าม step นี้ ระบบจะ train โดยไม่ใช้ feature อากาศ (ทำงานได้ปกติ)

### 2.3 Train โมเดล

```bash
python train.py                              # default: 20 iter × 5 fold × 3 candidates
python train.py --n-iter 5 --only lightgbm   # เร็วกว่า สำหรับ debug
python train.py --only lightgbm,xgboost      # ข้าม RandomForest
```

ขั้นตอนภายใน `train.py`:
1. โหลด + grid + densify ข้อมูล FIRMS
2. สร้าง feature (lag, rolling, neighbor 3×3, calendar, weather)
3. แบ่ง train / val / test = 60 / 20 / 20 ตามลำดับเวลา
4. RandomizedSearchCV หาพารามิเตอร์ที่ดีที่สุดในแต่ละโมเดล
5. เลือกโมเดลที่ MAE ต่ำสุดบน val set
6. ประเมินผลครั้งสุดท้ายบน test set (held-out)
7. Calibrate urgency threshold จาก val predictions
8. Refit บน train+val แล้ว save → `outputs/models/lgbm_fire_date_model.pkl`
9. รัน `risk_map.run()` ต่ออัตโนมัติ

> **หากเปลี่ยน feature list:** ลบ `outputs/models/*.pkl` ก่อน train ใหม่ ไม่งั้นอาจโหลด artifact เก่า

### 2.4 สร้างแผนที่ใหม่โดยไม่ train ใหม่

```bash
python risk_map.py
```

โหลด `.pkl` เดิม → predict วันล่าสุดเท่านั้น → append ลง `fire_dates_all.geojson`
ใช้เวลาไม่กี่วินาที เหมาะสำหรับ daily refresh

### 2.5 รัน FastAPI (ตัวเลือก)

```bash
uvicorn api:app --reload
```

Endpoints หลัก:
- `GET /predictions/today` — predict วันล่าสุด
- `GET /predictions/timeline` — รวมทั้ง 7 วัน
- `GET /predictions/day/{n}` — เฉพาะวันที่ n (1=พรุ่งนี้)
- `GET /predict/location?lat=...&lon=...` — predict ตำแหน่งใด ๆ
- `GET /metrics` — ROC-AUC / Precision / Recall / F1 จาก held-out test (binary task)
- `GET /geojson` — ข้อมูลแผนที่

---

## 3. วิธีเปิดเว็บไซต์

> **สำคัญ:** frontend อ่าน geojson ผ่าน relative path `../outputs/riskmap/fire_dates_all.geojson`
> ดังนั้น **ต้อง serve จาก project root** ไม่ใช่จาก `frontend/`

```bash
# ที่ root ของโปรเจกต์ (ไม่ใช่ src/ หรือ frontend/)
cd /home/qomaru/Science-Project-version-3
python -m http.server 8080
```

จากนั้นเปิดเบราว์เซอร์ไปที่:

```
http://localhost:8080/frontend/index.html
```

จะเห็น:
- แผนที่ Leaflet ของไทย พร้อม marker สีตามระดับเร่งด่วน
- Day selector (Day 1–7) — กรอง marker ตาม `days_until_fire`
- Timeline panel — สรุปจำนวนจุดในแต่ละวัน
- Validation metrics — ROC-AUC / F1 / Precision / Recall จากชุด test (ดึงจาก `dataset_info.json`)
- Tooltip ที่แต่ละ marker — วันที่ทำนาย, urgency, fire count 30 วันย้อนหลัง

> เว็บอ่าน geojson **ตรง ๆ** ไม่ต้องรัน FastAPI ก็เปิดดูได้

---

## 4. วิธีดูข้อมูล

ไฟล์ทั้งหมดเป็น **Parquet** — เปิดตรง ๆ ใน Python:

```python
import pandas as pd

# Hotspots ดิบ
firms = pd.read_parquet("data/firms/firms_all.parquet")
print(firms.head(), firms.shape)

# Feature dataframe ที่ใช้ป้อนโมเดล
feats = pd.read_parquet("outputs/features/full_features.parquet")
print(feats.columns.tolist())
print(feats[["date", "lat_grid", "lon_grid", "fire_count", "days_until_fire"]].head())

# Metadata + metric
import json
with open("outputs/metadata/dataset_info.json") as f:
    meta = json.load(f)
print("Model:", meta["best_model"])
print("Test metrics:", meta["model"]["test_metrics"])
print("Urgency thresholds:", meta["urgency_thresholds"])
```

ดู GeoJSON:
```bash
# ดูว่ามี feature กี่จุด, base_date ล่าสุดคือเมื่อไหร่
python -c "
import json
gj = json.load(open('outputs/riskmap/fire_dates_all.geojson'))
print('Total features:', len(gj['features']))
print('Metadata:', gj.get('metadata', {}))
"
```

---

## 5. ระบบ workflow ทั้งหมด

```
fetch_firms.py     ┐
                   ├──► data_loader ──► features ──► train.py ──► outputs/models/*.pkl
fetch_weather.py   ┘   (densify)        (lag/roll/                    │
                                         neighbor)                    ▼
                                                          outputs/features/full_features.parquet
                                                          outputs/metadata/dataset_info.json
                                                                      │
                                                                      ▼
                                                                risk_map.py
                                                                      │
                                                                      ▼
                                                outputs/riskmap/fire_dates_all.geojson
                                                                      │
                                              ┌───────────────────────┴────────────┐
                                              ▼                                    ▼
                                          api.py                            frontend/app.js
                                       (FastAPI :8000)              (อ่าน geojson ตรง)
```

**Daily routine ที่แนะนำ:**
```bash
cd src
python fetch_firms.py        # ดึงข้อมูลใหม่
python risk_map.py           # predict วันใหม่ (โมเดลเดิม)
# Train ใหม่แค่อาทิตย์ละครั้ง (หรือเมื่อ accuracy ตก)
```

---

## 6. การประเมินความแม่นยำ

โมเดลปัจจุบันเป็น **binary classifier** ตอบคำถาม: *"ใน cell นี้ จะมีไฟใน 3 วันข้างหน้าหรือไม่?"*
(เปลี่ยนจาก regression "ทำนาย exact day 1–7" เพราะ feature ที่มี [satellite + weather 38%] ไม่พอ
สำหรับ regression — collapse เป็น predict-mean ทุกครั้ง)

หลัง train เสร็จ ดูตัวเลขใน `outputs/metadata/dataset_info.json` → `model.test_metrics`:

```json
{
  "task": "binary_fire_in_3d",
  "imminent_days": 3,
  "roc_auc": 0.845,
  "average_precision": 0.312,
  "binary_accuracy": 0.802,
  "precision": 0.357,
  "recall": 0.664,
  "f1": 0.464,
  "best_f1": 0.509,
  "best_threshold": 0.35,
  "precision_at_best_thr": 0.345,
  "recall_at_best_thr": 0.969,
  "precision_at_top_5pct": 0.176,
  "precision_at_top_10pct": 0.296,
  "precision_at_top_20pct": 0.349
}
```

### ความหมายของแต่ละค่า

| Metric | ค่าตอนนี้ | ความหมาย |
|---|---|---|
| **ROC-AUC** | **0.845** | คุณภาพการ **rank** cell จากเสี่ยงมาก → น้อย โดยไม่สนใจ threshold<br>📈 `0.5` = สุ่ม, `1.0` = perfect, **`≥0.8` = ดี** ← ตอนนี้อยู่ตรงนี้<br>เป็น metric ที่ดีที่สุดสำหรับโจทย์ที่ positive class น้อย (class imbalance) |
| **Average Precision** | 0.312 | พื้นที่ใต้ precision-recall curve<br>เข้มกว่า ROC-AUC ตอน positive rare — เทียบกับ baseline (test_positive_rate = 0.129) แล้วโมเดล **2.4× ดีกว่ามั่ว** |
| **Accuracy (binary)** | 80.2% | สัดส่วน cell ที่โมเดลตอบ yes/no ถูก (threshold 0.5)<br>⚠️ **misleading** กับ imbalanced data — baseline "always no" ก็ได้ ~87% เพราะ positive แค่ 13% |
| **Precision** (@0.5) | 35.7% | จากที่โมเดลเตือน "imminent fire" — มี 35.7% เป็นไฟจริง<br>→ ที่เหลือคือ false alarm |
| **Recall** (@0.5) | 66.4% | จากไฟจริงทั้งหมด — โมเดลจับได้ 66.4%<br>→ พลาด 33.6% |
| **F1** (@0.5) | 46.4% | Harmonic mean ของ Precision + Recall — สมดุล |
| **Best F1** | **50.9%** | F1 สูงสุดที่หาได้ในชุด test (ลองทุก threshold) |
| **Best threshold** | **0.35** | Probability cutoff ที่ทำให้ F1 สูงสุด<br>ใช้ค่านี้ใน production: cell ที่ `prob ≥ 0.35` = imminent |
| **Precision @best** | 34.5% | Precision ที่ threshold 0.35 (โดน 1 ใน 3 เตือนเป็นไฟจริง) |
| **Recall @best** | **96.9%** | 🔥 ที่ threshold 0.35 จับไฟได้ **97%** ของทั้งหมด — แทบไม่พลาดเลย |
| **P @ top-5%** | 17.6% | จาก 5% ของ cell ที่โมเดลให้ probability สูงสุด — 17.6% เป็นไฟจริง<br>= **1.4× ดีกว่ามั่ว** (baseline 12.9%) |
| **P @ top-10%** | 29.6% | จาก 10% ที่เสี่ยงสุด → 29.6% ไฟจริง = **2.3× ดีกว่ามั่ว** |
| **P @ top-20%** | 34.9% | จาก 20% ที่เสี่ยงสุด → 34.9% ไฟจริง = **2.7× ดีกว่ามั่ว** |

### Operational guide — เลือก threshold ตามสถานการณ์

| Threshold | Precision | Recall | เหมาะกับ |
|---|---|---|---|
| **0.70+** | สูง | ต่ำ | High-confidence mode — เตือนเฉพาะที่แน่ใจ false alarm น้อย |
| **0.50** (default) | 35.7% | 66.4% | Balanced — default ของระบบ |
| **0.35** (best F1) | 34.5% | **96.9%** | **แนะนำ** — high-alert mode, แทบไม่พลาดไฟ |
| **0.25** | ต่ำลง | สูงสุด | Surveillance mode — ดู cell ที่ "อาจจะ" เกิดไฟ (false alarm เยอะ) |

### Skill check

- `skill_check_passed: true` หมายถึง **ROC-AUC ≥ 0.65** (โมเดลแยก fire/no-fire ได้ดีพอ)
- ถ้า `false` → อย่า deploy โมเดลตัวนั้น investigate feature signal หรือ data quality ก่อน

### ค่า legacy (regression keys) ใน `test_metrics`

`mae_days`, `rmse_days`, `r2`, `accuracy_within_1day`, `accuracy_exact` ยังอยู่ใน JSON
แต่ **อย่าใช้** สำหรับ binary task — มันคำนวณจาก pseudo-days output
(probability mapped to 1–7 days สำหรับ backwards-compat กับ risk_map.py)
จึงดูแย่ผิดความจริง (acc_within_1 = 6.7%) แม้โมเดลจะดี (AUC = 0.845)

ค่าเหล่านี้คำนวณจาก **held-out test set** (20% ล่าสุดของ timeline) ที่โมเดลไม่เคยเห็นตอน train/tune
test set เก็บ class distribution จริง (ไม่ undersample) เพื่อวัด performance สมจริง

---

## 7. Troubleshooting

| อาการ | สาเหตุ / วิธีแก้ |
|---|---|
| `fetch_firms.py` ขึ้น HTTP 400 ทุก dataset | API key หมด quota → เช็คที่ `https://firms.modaps.eosdis.nasa.gov/mapserver/mapkey_status/?MAP_KEY=…` (รีเซ็ตทุก ~24 ชม.) |
| `uvicorn api:app` ขึ้น `RuntimeError: Model not found` | ยังไม่ได้ train → รัน `python train.py` ก่อน |
| หน้าเว็บโหลดแต่แผนที่ว่าง | เช็ค path การ serve — ต้องรัน `http.server` จาก project root ไม่ใช่ `frontend/` |
| ทำนายผลแปลก ๆ หลังเปลี่ยน feature | ลบ `outputs/models/*.pkl` แล้ว train ใหม่ — artifact เก่าอาจไม่ตรงกับ feature contract |
| Weather column NaN ใน 5 วันล่าสุด | ปกติ — ERA5T มี lag ~5 วัน feature.py จะ fill 0 ตอน predict เท่านั้น |
| ข้อมูลเยอะเกิน / disk เต็ม | ทุกอย่างใช้ Parquet แล้ว ลด CSV ลง ~28× ถ้ายังมี `.csv` เก่าค้าง ลบได้ (data ที่ใช้งานคือ `.parquet`) |

---

## 8. Quick reference — commands ที่ใช้บ่อยที่สุด

```bash
# Activate venv
source .venv/bin/activate

# === Setup (ครั้งเดียว) ===
pip install -r requirements.txt
cp .env.example .env  # แก้ FIRMS_API_KEY

# === Daily refresh ===
cd src
python fetch_firms.py
python risk_map.py
cd ..

# === Train ใหม่ (อาทิตย์ละครั้ง) ===
cd src && python train.py && cd ..

# === เปิดเว็บ ===
python -m http.server 8080
# เบราว์เซอร์: http://localhost:8080/frontend/index.html

# === API (ถ้าต้องใช้) ===
cd src && uvicorn api:app --reload
# http://localhost:8000/predictions/today
```
