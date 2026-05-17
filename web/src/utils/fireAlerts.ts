import { useEffect, useRef, useState } from "react";
import type { GistdaFeature } from "../types";

// ─────────────────────────────────────────────────────────────
// Real-time fire alert system
//
// Polls GISTDA NRT VIIRS hotspots every few minutes (managed by App.tsx).
// This module:
//   1. Detects NEW fires by diffing the latest batch against what we've
//      already shown (Set of stable fire IDs).
//   2. Emits toast notifications for new fires (always — even with tab
//      focused).
//   3. Triggers Browser Notification API for OS-level push (requires the
//      user to grant permission once) — works when the tab is in the
//      background, on a different desktop, etc.
//   4. Optional audio "ding" so the user notices in noisy environments.
//
// First-load behaviour: we DO NOT alert for the initial batch (would
// flood the screen with all historic fires on page load). We mark that
// batch as "already seen" and start detecting deltas from there.
// ─────────────────────────────────────────────────────────────

export interface FireAlert {
  id: string;
  lat: number;
  lon: number;
  province: string;
  district: string;
  satellite: string;
  acqDateTime: string;       // ISO string when GISTDA detected it
  confident: string;          // GISTDA confidence band
  landUse: string;
  detectedAt: number;         // Date.now() when our system first saw it
  dismissed: boolean;
}

function _stableId(f: GistdaFeature): string {
  const a = f.attributes;
  const lat = Number(a.latitude);
  const lon = Number(a.longitude);
  // Round lat/lon to 4dp to be tolerant of tiny coordinate jitter
  // between consecutive GISTDA polls.
  const k = `${lat.toFixed(4)},${lon.toFixed(4)},${a.date ?? ""},${a.time ?? ""},${a.satellite ?? ""}`;
  return k;
}

function _formatAcqDateTime(date?: number, time?: string): string {
  // GISTDA delivers date as YYYYMMDD integer and time as HH:MM string
  if (!date) return "";
  const s = String(date);
  if (s.length !== 8) return "";
  const iso = `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
  return time ? `${iso}T${time}` : iso;
}

function _featureToAlert(f: GistdaFeature): FireAlert {
  const a = f.attributes;
  return {
    id: _stableId(f),
    lat: Number(a.latitude) || 0,
    lon: Number(a.longitude) || 0,
    province: (a.pv_tn ?? "").toString() || "—",
    district: (a.ap_tn ?? "").toString() || "—",
    satellite: (a.satellite ?? "").toString() || "VIIRS",
    acqDateTime: _formatAcqDateTime(a.date as number, a.time as string),
    confident: (a.confident ?? "").toString(),
    landUse: (a.lu_name ?? "").toString() || "—",
    detectedAt: Date.now(),
    dismissed: false,
  };
}

// ── Browser Notification API helpers ──
export type NotifyPermission = "default" | "granted" | "denied" | "unsupported";

export function getNotificationPermission(): NotifyPermission {
  if (typeof Notification === "undefined") return "unsupported";
  return Notification.permission as NotifyPermission;
}

export async function requestNotificationPermission(): Promise<NotifyPermission> {
  if (typeof Notification === "undefined") return "unsupported";
  try {
    const result = await Notification.requestPermission();
    return result as NotifyPermission;
  } catch {
    return "denied";
  }
}

function _osNotify(alert: FireAlert) {
  if (typeof Notification === "undefined" || Notification.permission !== "granted") return;
  try {
    new Notification("🔥 ตรวจพบไฟใหม่!", {
      body: `${alert.province} · ${alert.district}\n${alert.lat.toFixed(3)}, ${alert.lon.toFixed(3)}`,
      icon: "/favicon.ico",
      tag: alert.id,           // dedupe across re-fires
      silent: false,
    });
  } catch {
    /* some browsers (iOS Safari pre-16) lack the constructor */
  }
}

// ── Audio "ding" — fire-and-forget WebAudio beep ──
let _audioCtx: AudioContext | null = null;
export function playAlertSound(volume = 0.15) {
  try {
    _audioCtx ??= new (window.AudioContext || (window as any).webkitAudioContext)();
    const ctx = _audioCtx;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.frequency.setValueAtTime(880, ctx.currentTime);
    osc.frequency.exponentialRampToValueAtTime(440, ctx.currentTime + 0.18);
    gain.gain.setValueAtTime(volume, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.25);
    osc.connect(gain).connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 0.26);
  } catch {
    /* Some browsers gate AudioContext until a user gesture — silent fail */
  }
}

interface UseFireAlertsOptions {
  enableSound?: boolean;
  enableOsNotify?: boolean;
  maxKeptAlerts?: number;
}

// ── Backend SSE stream (faster than the per-tab polling fallback) ──
//
// Returns a hook that opens an EventSource to /api/fires/stream and yields
// the latest "new fire" event. The backend polls GISTDA every 60s server-
// side and pushes to all subscribers — so multiple tabs share one poll and
// new detections appear within ~60s instead of waiting for the next
// browser-side poll cycle.
export function useFireSseStream(): { lastFireAt: number; connected: boolean } {
  const [state, setState] = useState({ lastFireAt: 0, connected: false });

  useEffect(() => {
    const base = (import.meta.env.VITE_API_BASE ?? "").replace(/\/$/, "");
    let es: EventSource | null = null;
    let cancelled = false;

    const open = () => {
      if (cancelled) return;
      try {
        es = new EventSource(`${base}/api/fires/stream`);
        es.onopen = () => setState((s) => ({ ...s, connected: true }));
        es.addEventListener("fire", () => {
          setState({ lastFireAt: Date.now(), connected: true });
        });
        es.onerror = () => {
          setState((s) => ({ ...s, connected: false }));
          es?.close();
          // Reconnect after 5s
          if (!cancelled) setTimeout(open, 5000);
        };
      } catch {
        setState((s) => ({ ...s, connected: false }));
      }
    };
    open();

    return () => {
      cancelled = true;
      es?.close();
    };
  }, []);

  return state;
}

export function useFireAlerts(
  liveFires: GistdaFeature[],
  { enableSound = true, enableOsNotify = true, maxKeptAlerts = 50 }: UseFireAlertsOptions = {}
) {
  const seenIdsRef = useRef<Set<string> | null>(null);
  const [alerts, setAlerts] = useState<FireAlert[]>([]);

  useEffect(() => {
    if (!liveFires.length) return;
    const currentIds = new Set(liveFires.map(_stableId));

    // First load — mark all as seen but don't alert. This avoids dumping
    // every historic detection onto the user's screen on page open.
    if (seenIdsRef.current === null) {
      seenIdsRef.current = currentIds;
      return;
    }

    const previous = seenIdsRef.current;
    const newFeatures = liveFires.filter((f) => !previous.has(_stableId(f)));
    if (newFeatures.length === 0) {
      // Update seen set in case ids rotated (still no new alerts)
      seenIdsRef.current = currentIds;
      return;
    }

    const newAlerts = newFeatures.map(_featureToAlert);
    if (enableSound) playAlertSound();
    if (enableOsNotify) newAlerts.forEach(_osNotify);

    setAlerts((prev) => {
      // Prepend new alerts, dedupe by id (in case React StrictMode re-runs)
      const merged: FireAlert[] = [];
      const seen = new Set<string>();
      for (const a of [...newAlerts, ...prev]) {
        if (seen.has(a.id)) continue;
        seen.add(a.id);
        merged.push(a);
      }
      return merged.slice(0, maxKeptAlerts);
    });

    seenIdsRef.current = currentIds;
  }, [liveFires, enableSound, enableOsNotify, maxKeptAlerts]);

  const dismissAlert = (id: string) => {
    setAlerts((prev) => prev.map((a) => (a.id === id ? { ...a, dismissed: true } : a)));
  };
  const dismissAll = () => {
    setAlerts((prev) => prev.map((a) => ({ ...a, dismissed: true })));
  };

  // Convenience: list of fire IDs that are "new" within the last N seconds —
  // used by MapView to render a pulse animation on the marker.
  const recentFireIds = (sinceMs = 60_000): Set<string> => {
    const cutoff = Date.now() - sinceMs;
    const ids = new Set<string>();
    for (const a of alerts) if (a.detectedAt >= cutoff) ids.add(a.id);
    return ids;
  };

  const activeAlerts = alerts.filter((a) => !a.dismissed);

  return {
    alerts,
    activeAlerts,
    dismissAlert,
    dismissAll,
    recentFireIds,
  };
}
