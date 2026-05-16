// Transparency / provenance panel — shows where every data column comes from.
// Each row links to the original public source so a sceptical reader can
// verify the numbers aren't made up. Key trust message: "real data only,
// no synthetic / random / interpolated values."

interface Source {
  icon: string;
  name: string;
  description: string;
  url: string;
  license: string;
  contributes: string;
}

const SOURCES: Source[] = [
  {
    icon: "🛰",
    name: "NASA FIRMS VIIRS NRT",
    description: "Near-real-time hotspots ทุก 3 ชั่วโมง จากดาวเทียม Suomi NPP + NOAA-20",
    url: "https://firms.modaps.eosdis.nasa.gov/",
    license: "Open / US Government",
    contributes: "fire_count, FRP, brightness, confidence + spatial-neighbor features",
  },
  {
    icon: "🌤",
    name: "ECMWF ERA5 Reanalysis",
    description: "อุณหภูมิ ความชื้น ลม ฝน ระดับ 0.25° (ผ่าน Open-Meteo Archive API)",
    url: "https://open-meteo.com/en/docs/historical-weather-api",
    license: "CC-BY 4.0",
    contributes: "temp_max/min, precip_sum, wind_max, et0 — coverage ~38% ตอนนี้",
  },
  {
    icon: "🌳",
    name: "Hansen GFC v1.11",
    description: "Tree cover baseline 2000 + recent loss",
    url: "https://glad.umd.edu/dataset/global-2010-tree-cover-30-m",
    license: "Open (University of Maryland)",
    contributes: "tree_cover_pct_2000, tree_loss_pct_recent",
  },
  {
    icon: "🇹🇭",
    name: "Thailand boundary GeoJSON",
    description: "ขอบเขต 77 จังหวัด จาก HDX",
    url: "https://data.humdata.org/dataset/cod-ab-tha",
    license: "Open",
    contributes: "is_in_thailand mask, province annotation",
  },
];

export default function DataSourcesPanel() {
  return (
    <div className="section">
      <h3>📡 Data Sources</h3>
      <p style={{ fontSize: 11, color: "var(--text-3)", marginBottom: 10 }}>
        ทุก feature มาจาก <b>แหล่งข้อมูลสาธารณะที่ตรวจสอบได้</b>.
        ไม่มี synthetic / random / interpolated values.
      </p>

      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        {SOURCES.map((s) => (
          <a
            key={s.name}
            href={s.url}
            target="_blank"
            rel="noopener noreferrer"
            style={{
              display: "block",
              padding: "10px 12px",
              background: "var(--surface-2)",
              borderRadius: 6,
              border: "1px solid var(--border)",
              textDecoration: "none",
              color: "inherit",
              transition: "border-color 0.12s",
            }}
            onMouseEnter={(e) => (e.currentTarget.style.borderColor = "var(--accent)")}
            onMouseLeave={(e) => (e.currentTarget.style.borderColor = "var(--border)")}
            title={`เปิด ${s.url}`}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <span style={{ fontSize: 16 }}>{s.icon}</span>
              <b style={{ fontSize: 13, color: "var(--text)" }}>{s.name}</b>
              <span style={{ fontSize: 10, color: "var(--text-3)" }}>↗</span>
            </div>
            <div style={{ fontSize: 11, color: "var(--text-2)", marginTop: 4, lineHeight: 1.4 }}>
              {s.description}
            </div>
            <div style={{ fontSize: 10, color: "var(--text-3)", marginTop: 4 }}>
              📋 {s.contributes}
            </div>
            <div style={{ fontSize: 10, color: "var(--text-3)", marginTop: 2 }}>
              ⚖️ {s.license}
            </div>
          </a>
        ))}
      </div>
    </div>
  );
}
