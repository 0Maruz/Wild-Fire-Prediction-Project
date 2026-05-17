// ─────────────────────────────────────────────────────────────
// Tiny CSV download helper for the Reports page export buttons.
//
// No deps — builds CSV string, blob URL, triggers download. Handles cells
// that contain commas / newlines / quotes via RFC 4180 quoting.
// ─────────────────────────────────────────────────────────────

type Cell = string | number | boolean | null | undefined;

export function formatCell(v: Cell): string {
  if (v === null || v === undefined) return "";
  const s = String(v);
  if (s.includes(",") || s.includes("\n") || s.includes('"')) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

/**
 * Build a CSV string from a 2-D array of cells.
 * First row is the header by convention but not enforced.
 */
export function buildCsv(rows: Cell[][]): string {
  return rows.map((row) => row.map(formatCell).join(",")).join("\n");
}

/**
 * Trigger a browser download of the given CSV content.
 */
export function downloadCsvString(filename: string, csv: string): void {
  // Prepend UTF-8 BOM so Excel opens Thai text correctly without garbling
  const blob = new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.style.display = "none";
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  // Defer revoke so the browser definitely picks up the URL first
  setTimeout(() => URL.revokeObjectURL(url), 100);
}

/**
 * One-shot: build CSV from rows and trigger download.
 */
export function downloadCsv(filename: string, rows: Cell[][]): void {
  downloadCsvString(filename, buildCsv(rows));
}

/**
 * Combine multiple tables into a single CSV with section headers + blank
 * separators. Each section opens with a `# === Name ===` comment line that
 * Excel/Sheets will leave alone but humans read as a title.
 *
 * Use for the "all-in-one" report download — convenient single attachment
 * for emailing or uploading to a research repository.
 */
export function buildMultiSectionCsv(sections: { name: string; rows: Cell[][] }[]): string {
  const lines: string[] = [];
  for (const s of sections) {
    lines.push("");
    lines.push(`# === ${s.name} ===`);
    if (s.rows.length === 0) {
      lines.push("# (no data)");
      continue;
    }
    for (const r of s.rows) {
      lines.push(r.map(formatCell).join(","));
    }
  }
  return lines.join("\n").trimStart();
}

export function downloadMultiSectionCsv(
  filename: string,
  sections: { name: string; rows: Cell[][] }[],
): void {
  downloadCsvString(filename, buildMultiSectionCsv(sections));
}
