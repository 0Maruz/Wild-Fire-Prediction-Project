import { useMemo, useRef, useState } from "react";
import type { FireFeature, GistdaFeature, LiveFireMeta } from "../types";

interface Props {
  liveFires: GistdaFeature[];               // GISTDA NRT — live <30 min latency
  observed: FireFeature[];                  // NASA FIRMS observed (last days)
  liveFireMeta: LiveFireMeta;
  onRefresh?: () => void;
  onNavigateToMap: (lat: number, lon: number) => void;
}

// ─────────────────────────────────────────────────────────────
// Live Fires Feed page — news-dashboard-style chronological list
// of REAL satellite fire detections.
//
// Two real-data sources, both verifiable independently:
//   1. GISTDA NRT VIIRS  — Thai government, < 30 min latency
//      verify: https://fire.gistda.or.th/
//   2. NASA FIRMS NRT    — NASA Earth Data, satellite thermal anomalies
//      verify: https://firms.modaps.eosdis.nasa.gov/map/
//
// What this page is NOT:
//   - Predictions (those live on /#dashboard)
//   - Citizen reports (no input mechanism yet)
//
// Each incident card links to the source's official map for verification.
// ─────────────────────────────────────────────────────────────

type IncidentSource = "GISTDA" | "FIRMS";

interface Incident {
  id: string;
  source: IncidentSource;
  detectedAt: number;         // unix ms
  detectedAtStr: string;      // human-readable
  lat: number;
  lon: number;
  province: string;
  district: string;
  satellite: string;
  confidence: string;
  landUse: string;
  verifyUrl: string;
  daysOld: number;             // how many days back this was detected
}

function _formatGistdaTime(date?: number, time?: string): { iso: string; ms: number } {
  if (!date) return { iso: "", ms: 0 };
  const s = String(date);
  if (s.length !== 8) return { iso: "", ms: 0 };
  const isoDate = `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
  const iso = time ? `${isoDate}T${time}:00+07:00` : `${isoDate}T00:00:00+07:00`;
  const ms = Date.parse(iso);
  return { iso, ms: isNaN(ms) ? 0 : ms };
}

function _gistdaToIncident(f: GistdaFeature): Incident {
  const a = f.attributes;
  const { iso, ms } = _formatGistdaTime(a.date as number, a.time as string);
  const lat = Number(a.latitude) || 0;
  const lon = Number(a.longitude) || 0;
  return {
    id: `gistda-${lat.toFixed(4)}-${lon.toFixed(4)}-${a.date ?? ""}-${a.time ?? ""}`,
    source: "GISTDA",
    detectedAt: ms,
    detectedAtStr: iso || "—",
    lat,
    lon,
    province: (a.pv_tn ?? "").toString() || "—",
    district: (a.ap_tn ?? "").toString() || "",
    satellite: (a.satellite ?? "VIIRS").toString(),
    confidence: (a.confident ?? "").toString(),
    landUse: (a.lu_name ?? "").toString() || "",
    verifyUrl: "https://fire.gistda.or.th/",
    daysOld: ms ? (Date.now() - ms) / 86_400_000 : 0,
  };
}

// Approximate Thailand bbox — used as a fallback for FIRMS observed features
// that don't have a province annotation (risk_map.py only annotates predicted
// cells; observed FIRMS rows in the GeoJSON keep raw lat/lon only).
// Bounds cover Mae Hong Son (NW) → Yala (S) → Ubon Ratchathani (E).
function _isInThailandBbox(lat: number, lon: number): boolean {
  return lat >= 5.5 && lat <= 20.6 && lon >= 97.3 && lon <= 105.7;
}

function _firmsObservedToIncident(f: FireFeature): Incident {
  const p = f.properties;
  const [lon, lat] = f.geometry.coordinates;
  const dateStr = p.date ?? "";
  const ms = dateStr ? Date.parse(dateStr + "T12:00:00+07:00") : 0;
  return {
    id: `firms-${lat.toFixed(4)}-${lon.toFixed(4)}-${dateStr}`,
    source: "FIRMS",
    detectedAt: ms,
    detectedAtStr: dateStr,
    lat,
    lon,
    province: p.province ?? "—",
    district: "",
    satellite: "VIIRS-SNPP/NOAA20",
    confidence: String(p.fire_count ?? ""),
    landUse: "",
    verifyUrl: `https://firms.modaps.eosdis.nasa.gov/map/#l:viirs;@${lon.toFixed(3)},${lat.toFixed(3)},9z`,
    daysOld: ms ? (Date.now() - ms) / 86_400_000 : 99,
  };
}

function _timeAgo(ms: number): string {
  if (!ms) return "—";
  const diff = (Date.now() - ms) / 1000;
  if (diff < 60) return `${Math.round(diff)} วินาทีที่แล้ว`;
  if (diff < 3600) return `${Math.round(diff / 60)} นาทีที่แล้ว`;
  if (diff < 86400) return `${Math.round(diff / 3600)} ชั่วโมงที่แล้ว`;
  return `${Math.round(diff / 86400)} วันที่แล้ว`;
}

const SOURCE_COLOR: Record<IncidentSource, string> = {
  GISTDA: "#06b6d4",   // cyan — matches live fires layer
  FIRMS:  "#f97316",   // orange — matches observed layer
};

const SOURCE_INFO: Record<IncidentSource, { full: string; org: string }> = {
  GISTDA: { full: "GISTDA NRT VIIRS", org: "สำนักงานพัฒนาเทคโนโลยีอวกาศและภูมิสารสนเทศ" },
  FIRMS:  { full: "NASA FIRMS",        org: "NASA Earth Science Data" },
};

export default function LiveFiresPage({
  liveFires, observed, liveFireMeta, onRefresh, onNavigateToMap,
}: Props) {
  const [sourceFilter, setSourceFilter] = useState<IncidentSource | "ALL">("ALL");
  const [provinceFilter, setProvinceFilter] = useState<string>("ALL");
  const [timeWindow, setTimeWindow] = useState<number>(3); // days
  const [search, setSearch] = useState<string>("");
  // Thailand-only filter — defaults ON because the FIRMS layer's BBOX
  // (96–107°E, 4–22°N) spills into Cambodia/Vietnam/Myanmar/Laos.
  // Without this filter the feed is mostly cross-border fires which isn't
  // what a Thai operator wants to see.
  const [thailandOnly, setThailandOnly] = useState<boolean>(true);
  const [showHelp, setShowHelp] = useState<boolean>(false);
  // Pagination — start with 50 visible, "load more" reveals 50 at a time.
  const [pageSize, setPageSize] = useState<number>(50);

  const incidents = useMemo<Incident[]>(() => {
    const out: Incident[] = [];
    for (const f of liveFires) out.push(_gistdaToIncident(f));
    for (const f of observed) out.push(_firmsObservedToIncident(f));
    out.sort((a, b) => b.detectedAt - a.detectedAt);
    return out;
  }, [liveFires, observed]);

  const provinces = useMemo(() => {
    const s = new Set<string>();
    for (const i of incidents) if (i.province && i.province !== "—") s.add(i.province);
    return Array.from(s).sort();
  }, [incidents]);

  const filtered = useMemo(() => {
    return incidents.filter((i) => {
      if (sourceFilter !== "ALL" && i.source !== sourceFilter) return false;
      if (provinceFilter !== "ALL" && i.province !== provinceFilter) return false;
      if (i.daysOld > timeWindow) return false;
      // Thailand only — accept if province is annotated OR coordinates fall
      // inside the Thai bbox (fallback for FIRMS observed rows, which the
      // backend doesn't yet annotate with province).
      if (thailandOnly) {
        const hasProvince = i.province && i.province !== "—";
        const inBbox = _isInThailandBbox(i.lat, i.lon);
        if (!hasProvince && !inBbox) return false;
      }
      if (search.trim()) {
        const q = search.toLowerCase();
        if (
          !i.province.toLowerCase().includes(q) &&
          !i.district.toLowerCase().includes(q) &&
          !`${i.lat},${i.lon}`.includes(q)
        ) return false;
      }
      return true;
    });
  }, [incidents, sourceFilter, provinceFilter, timeWindow, search, thailandOnly]);

  // Cross-verification: for each incident, find other-source incidents within
  // 12 km AND 24h. If any → flag "✓ cross-verified by other satellite".
  const crossVerified = useMemo(() => {
    const map = new Map<string, IncidentSource[]>();
    const others = incidents;
    for (const i of incidents) {
      const matches: IncidentSource[] = [];
      for (const o of others) {
        if (o.id === i.id || o.source === i.source) continue;
        const dLat = (i.lat - o.lat) * 111;
        const dLon = (i.lon - o.lon) * 111 * Math.cos((i.lat * Math.PI) / 180);
        const km = Math.sqrt(dLat * dLat + dLon * dLon);
        const dt = Math.abs(i.detectedAt - o.detectedAt);
        if (km <= 12 && dt <= 24 * 3600 * 1000) matches.push(o.source);
      }
      if (matches.length) map.set(i.id, Array.from(new Set(matches)));
    }
    return map;
  }, [incidents]);

  const sourceCounts = useMemo(() => {
    const c = { GISTDA: 0, FIRMS: 0, total: 0, last1h: 0, last24h: 0 };
    for (const i of incidents) {
      if (i.source === "GISTDA") c.GISTDA++;
      if (i.source === "FIRMS") c.FIRMS++;
      c.total++;
      if (i.daysOld * 24 <= 1) c.last1h++;
      if (i.daysOld <= 1) c.last24h++;
    }
    return c;
  }, [incidents]);

  const liveStatus = liveFireMeta.status;
  const liveStatusLabel =
    liveStatus === "ok" ? `live · ${liveFireMeta.count} active`
    : liveStatus === "loading" ? "loading…"
    : liveStatus === "error" ? "API error"
    : "idle";

  // Reset pagination whenever filters change so user starts from the top
  // again — otherwise switching province while at page 200 looks empty.
  const filterKey = `${sourceFilter}|${provinceFilter}|${timeWindow}|${search}|${thailandOnly}`;
  const lastFilterKeyRef = useRef<string>(filterKey);
  if (lastFilterKeyRef.current !== filterKey) {
    lastFilterKeyRef.current = filterKey;
    if (pageSize !== 50) setPageSize(50);
  }

  return (
    <div className="notify-page">
      <header className="notify-page-header" style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 16, flexWrap: "wrap" }}>
        <div>
          <h1>🔥 ไฟสด · Real-time Fire Incidents</h1>
          <p className="notify-page-subtitle">
            จุดที่ดาวเทียม "เห็นไฟจริง" ในเวลาใกล้เคียง real-time · จาก 2 หน่วยงานอิสระ
            <button
              type="button"
              onClick={() => setShowHelp(!showHelp)}
              style={{ marginLeft: 8, background: "transparent", border: "none", color: "var(--accent)", cursor: "pointer", fontSize: 12, fontWeight: 600 }}
            >
              {showHelp ? "ซ่อนคำอธิบาย ▲" : "ดูคำอธิบายเพิ่ม ▼"}
            </button>
          </p>
        </div>
        <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
          <span className={`status-badge ${liveStatus === "ok" ? "great" : liveStatus === "error" ? "bad" : "ok"}`}>
            ⚡ GISTDA {liveStatusLabel}
          </span>
          {onRefresh && (
            <button type="button" className="action-btn" onClick={onRefresh} title="Refresh feed">
              ↻ Refresh
            </button>
          )}
        </div>
      </header>

      {showHelp && (
        <div className="help-card" style={{
          background: "var(--surface)",
          border: "1px solid var(--border)",
          borderLeft: "4px solid var(--accent)",
          borderRadius: 8,
          padding: "16px 20px",
          marginBottom: 16,
        }}>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(2, 1fr)", gap: 18, marginBottom: 16 }}>
            {/* GISTDA */}
            <div style={{ borderLeft: `3px solid ${SOURCE_COLOR.GISTDA}`, paddingLeft: 14 }}>
              <h4 style={{ fontSize: 13, fontWeight: 700, marginBottom: 6, color: SOURCE_COLOR.GISTDA }}>
                🛰 GISTDA (สำนักงานพัฒนาเทคโนโลยีอวกาศและภูมิสารสนเทศ)
              </h4>
              <p style={{ fontSize: 12, color: "var(--text-2)", lineHeight: 1.55, marginBottom: 6 }}>
                หน่วยงานราชการไทย · ดึงข้อมูลดาวเทียม VIIRS แล้วประมวลผลเอง
              </p>
              <ul style={{ fontSize: 11, color: "var(--text-3)", paddingLeft: 18, lineHeight: 1.6 }}>
                <li>Latency: <b>~30 นาที</b> หลัง satellite pass</li>
                <li>ครอบคลุม: เฉพาะประเทศไทย</li>
                <li>มีข้อมูล: จังหวัด, อำเภอ, ประเภทพื้นที่ (lu_name)</li>
                <li>ยืนยันที่: <a href="https://fire.gistda.or.th/" target="_blank" rel="noopener noreferrer" style={{ color: SOURCE_COLOR.GISTDA }}>fire.gistda.or.th</a></li>
              </ul>
            </div>
            {/* FIRMS */}
            <div style={{ borderLeft: `3px solid ${SOURCE_COLOR.FIRMS}`, paddingLeft: 14 }}>
              <h4 style={{ fontSize: 13, fontWeight: 700, marginBottom: 6, color: SOURCE_COLOR.FIRMS }}>
                🛰 NASA FIRMS (Fire Information for Resource Management System)
              </h4>
              <p style={{ fontSize: 12, color: "var(--text-2)", lineHeight: 1.55, marginBottom: 6 }}>
                NASA Earth Science Data · ดาวเทียม Suomi-NPP + NOAA-20 VIIRS
              </p>
              <ul style={{ fontSize: 11, color: "var(--text-3)", paddingLeft: 18, lineHeight: 1.6 }}>
                <li>Latency: <b>3–6 ชั่วโมง</b> หลัง satellite pass</li>
                <li>ครอบคลุม: ทั่วโลก (ของเรากรอง BBOX 4–22°N, 96–107°E)</li>
                <li>มีข้อมูล: lat/lon, satellite, confidence band</li>
                <li>ยืนยันที่: <a href="https://firms.modaps.eosdis.nasa.gov/map/" target="_blank" rel="noopener noreferrer" style={{ color: SOURCE_COLOR.FIRMS }}>firms.modaps.eosdis.nasa.gov</a></li>
              </ul>
            </div>
          </div>

          <div style={{ padding: "12px 14px", background: "var(--surface-2)", borderRadius: 6, marginBottom: 12 }}>
            <h4 style={{ fontSize: 12, fontWeight: 700, marginBottom: 6, color: "var(--text)" }}>
              ✓ ดูยังไงว่าเป็น "ไฟจริง"?
            </h4>
            <ol style={{ fontSize: 12, color: "var(--text-2)", paddingLeft: 18, lineHeight: 1.7 }}>
              <li><b>กดปุ่ม "🔗 Verify"</b> ของ entry ใดๆ → จะเปิดเว็บ official ของ NASA/GISTDA → หา hotspot ที่ตำแหน่งเดียวกัน → ตรงกัน = ของจริง</li>
              <li><b>มอง badge ✓ Cross-verified</b> (สีเขียว) — แปลว่า "ทั้ง 2 ดาวเทียมเห็นไฟตำแหน่งเดียวกัน ใน 24 ชม." → น่าเชื่อมาก</li>
              <li><b>confidence ของ GISTDA:</b> H (สูง), N (ปกติ), L (ต่ำ) — H ใกล้แน่นอน 100%</li>
            </ol>
          </div>

          <div style={{ padding: "10px 12px", background: "rgba(234, 179, 8, 0.10)", border: "1px solid rgba(234, 179, 8, 0.3)", borderRadius: 6, fontSize: 11, color: "var(--text-2)", lineHeight: 1.55 }}>
            ⚠ <b>ทำไมบาง entry ไม่มีจังหวัด:</b> FIRMS รวบรวมจุดร้อนใน BBOX ทั้งหมด (96–107°E ครอบคลุมไทย+ลาว+กัมพูชา+เวียดนาม+พม่าเหนือ) — entry ที่ไม่มีจังหวัด = อยู่นอกไทย.
            เปิด toggle <b>"🇹🇭 ในไทยเท่านั้น"</b> ด้านล่างเพื่อกรองออก
          </div>
        </div>
      )}

      {/* Top counts strip */}
      <div className="alert-counts" style={{ gridTemplateColumns: "repeat(4, 1fr)" }}>
        <div className="alert-count-card" style={{ borderLeftColor: "#ef4444" }}>
          <div className="alert-count-label" style={{ color: "#ef4444" }}>ใน 1 ชม.</div>
          <div className="alert-count-value">{sourceCounts.last1h}</div>
        </div>
        <div className="alert-count-card" style={{ borderLeftColor: "#f97316" }}>
          <div className="alert-count-label" style={{ color: "#f97316" }}>ใน 24 ชม.</div>
          <div className="alert-count-value">{sourceCounts.last24h}</div>
        </div>
        <button
          type="button"
          className={`alert-count-card ${sourceFilter === "GISTDA" ? "active" : ""}`}
          onClick={() => setSourceFilter(sourceFilter === "GISTDA" ? "ALL" : "GISTDA")}
          style={{ borderLeftColor: SOURCE_COLOR.GISTDA }}
        >
          <div className="alert-count-label" style={{ color: SOURCE_COLOR.GISTDA }}>GISTDA</div>
          <div className="alert-count-value">{sourceCounts.GISTDA}</div>
        </button>
        <button
          type="button"
          className={`alert-count-card ${sourceFilter === "FIRMS" ? "active" : ""}`}
          onClick={() => setSourceFilter(sourceFilter === "FIRMS" ? "ALL" : "FIRMS")}
          style={{ borderLeftColor: SOURCE_COLOR.FIRMS }}
        >
          <div className="alert-count-label" style={{ color: SOURCE_COLOR.FIRMS }}>FIRMS</div>
          <div className="alert-count-value">{sourceCounts.FIRMS}</div>
        </button>
      </div>

      {/* Filters */}
      <div className="alert-filters">
        <label style={{
          display: "inline-flex", alignItems: "center", gap: 6,
          padding: "7px 10px",
          background: thailandOnly ? "var(--accent-soft)" : "var(--surface)",
          border: `1px solid ${thailandOnly ? "var(--accent)" : "var(--border)"}`,
          borderRadius: 5,
          fontSize: 12,
          color: thailandOnly ? "var(--accent)" : "var(--text-2)",
          fontWeight: 600,
          cursor: "pointer",
        }}>
          <input
            type="checkbox"
            checked={thailandOnly}
            onChange={(e) => setThailandOnly(e.target.checked)}
            style={{ margin: 0 }}
          />
          🇹🇭 ในไทยเท่านั้น
        </label>
        <select value={sourceFilter} onChange={(e) => setSourceFilter(e.target.value as IncidentSource | "ALL")}>
          <option value="ALL">ทุก source</option>
          <option value="GISTDA">GISTDA only</option>
          <option value="FIRMS">FIRMS only</option>
        </select>
        <select value={provinceFilter} onChange={(e) => setProvinceFilter(e.target.value)}>
          <option value="ALL">ทุกจังหวัด</option>
          {provinces.map((p) => <option key={p} value={p}>{p}</option>)}
        </select>
        <select value={timeWindow} onChange={(e) => setTimeWindow(Number(e.target.value))}>
          <option value={0.25}>6 ชั่วโมงล่าสุด</option>
          <option value={1}>24 ชั่วโมงล่าสุด</option>
          <option value={3}>3 วันล่าสุด</option>
          <option value={7}>7 วันล่าสุด</option>
          <option value={30}>30 วันล่าสุด</option>
        </select>
        <input
          type="search"
          placeholder="ค้นหาจังหวัด/อำเภอ/พิกัด..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <div className="alert-filter-summary">
          {filtered.length} / {incidents.length} incidents
        </div>
      </div>

      {/* Feed */}
      {filtered.length === 0 ? (
        <div className="empty-state">
          <div className="empty-icon">🌲</div>
          <div className="empty-title">ไม่มีไฟใน timeline ที่เลือก</div>
          <div className="empty-hint">
            ลองขยาย time window หรือเปลี่ยน filter · ช่วงนอกฤดูเผา (พ.ค.–ต.ค.) ไฟจะน้อยมาก
          </div>
        </div>
      ) : (
        <div className="incident-feed">
          {filtered.slice(0, pageSize).map((i) => {
            const verified = crossVerified.get(i.id);
            const isFresh = (Date.now() - i.detectedAt) < 5 * 60 * 1000;  // < 5 min old
            return (
              <article
                key={i.id}
                className={`incident-card${isFresh ? " incident-card-fresh" : ""}`}
                style={{ borderLeftColor: SOURCE_COLOR[i.source] }}
              >
                <div className="incident-time">
                  <div className="incident-time-rel">{_timeAgo(i.detectedAt)}</div>
                  <div className="incident-time-abs">{i.detectedAtStr}</div>
                </div>
                <div className="incident-body">
                  <div className="incident-headline">
                    <span className="incident-source-badge" style={{ background: SOURCE_COLOR[i.source] + "22", color: SOURCE_COLOR[i.source], borderColor: SOURCE_COLOR[i.source] + "55" }}>
                      🛰 {i.source}
                    </span>
                    {verified && verified.length > 0 && (
                      <span className="incident-verified" title={`Cross-verified by ${verified.join(", ")}`}>
                        ✓ Cross-verified
                      </span>
                    )}
                    {i.confidence && (
                      <span className="incident-conf">conf: {i.confidence}</span>
                    )}
                  </div>
                  <h3 className="incident-location">
                    {i.province && i.province !== "—" ? (
                      <>
                        {i.province}
                        {i.district ? <span className="incident-district"> · {i.district}</span> : null}
                      </>
                    ) : _isInThailandBbox(i.lat, i.lon) ? (
                      <span style={{ color: "var(--text-2)", fontWeight: 500, fontSize: 14 }}>
                        🇹🇭 พื้นที่ไทย <span style={{ color: "var(--text-3)", fontSize: 11 }}>(ไม่ระบุจังหวัด)</span>
                      </span>
                    ) : (
                      <span style={{ color: "var(--text-3)", fontWeight: 500, fontSize: 13 }}>
                        🌏 นอกประเทศไทย (ลาว/พม่า/กัมพูชา/เวียดนาม)
                      </span>
                    )}
                  </h3>
                  <div className="incident-meta">
                    <span className="mono">{i.lat.toFixed(4)}°N · {i.lon.toFixed(4)}°E</span>
                    {i.satellite && <span>📡 {i.satellite}</span>}
                    {i.landUse && <span>🌿 {i.landUse}</span>}
                  </div>
                  <div className="incident-actions">
                    <button
                      type="button"
                      className="action-btn"
                      style={{ padding: "4px 10px", fontSize: 11 }}
                      onClick={() => onNavigateToMap(i.lat, i.lon)}
                    >
                      📍 ดูบนแผนที่
                    </button>
                    <a
                      href={i.verifyUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="action-btn"
                      style={{ padding: "4px 10px", fontSize: 11, textDecoration: "none" }}
                      title={`Verify on ${SOURCE_INFO[i.source].full} official map`}
                    >
                      🔗 Verify ที่ {i.source}
                    </a>
                  </div>
                </div>
              </article>
            );
          })}
          {filtered.length > pageSize ? (
            <div style={{
              display: "flex", flexDirection: "column", gap: 8, alignItems: "center",
              padding: "16px 12px", background: "var(--surface-2)", borderRadius: 8,
              marginTop: 6,
            }}>
              <div style={{ fontSize: 12, color: "var(--text-3)" }}>
                แสดง <b style={{ color: "var(--text)" }}>{pageSize}</b> จาก <b style={{ color: "var(--text)" }}>{filtered.length}</b> incidents
              </div>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap", justifyContent: "center" }}>
                <button
                  type="button"
                  className="action-btn primary"
                  onClick={() => setPageSize(pageSize + 50)}
                >
                  ⬇ โหลดอีก 50
                </button>
                <button
                  type="button"
                  className="action-btn"
                  onClick={() => setPageSize(pageSize + 200)}
                >
                  ⬇⬇ โหลดอีก 200
                </button>
                <button
                  type="button"
                  className="action-btn"
                  onClick={() => setPageSize(filtered.length)}
                >
                  ⬇⬇⬇ แสดงทั้งหมด ({filtered.length})
                </button>
              </div>
            </div>
          ) : pageSize > 50 ? (
            <div style={{ textAlign: "center", padding: 12 }}>
              <button
                type="button"
                className="action-btn"
                onClick={() => setPageSize(50)}
                style={{ fontSize: 11 }}
              >
                ⬆ ย่อกลับ (50)
              </button>
            </div>
          ) : null}
        </div>
      )}

      {/* Footer attribution */}
      <footer className="report-footer">
        <p style={{ fontSize: 11, color: "var(--text-3)" }}>
          📡 Data sources (independent, verifiable):
        </p>
        <div style={{ display: "flex", gap: 16, flexWrap: "wrap", marginTop: 8, justifyContent: "center" }}>
          <a href="https://fire.gistda.or.th/" target="_blank" rel="noopener noreferrer"
             style={{ fontSize: 11, color: SOURCE_COLOR.GISTDA, textDecoration: "none" }}>
            🛰 GISTDA · fire.gistda.or.th
          </a>
          <a href="https://firms.modaps.eosdis.nasa.gov/map/" target="_blank" rel="noopener noreferrer"
             style={{ fontSize: 11, color: SOURCE_COLOR.FIRMS, textDecoration: "none" }}>
            🛰 NASA FIRMS · firms.modaps.eosdis.nasa.gov
          </a>
        </div>
      </footer>
    </div>
  );
}
