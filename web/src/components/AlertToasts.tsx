import { useEffect, useState } from "react";
import type { FireAlert } from "../utils/fireAlerts";
import {
  getNotificationPermission, requestNotificationPermission,
  type NotifyPermission,
} from "../utils/fireAlerts";

interface Props {
  alerts: FireAlert[];
  onDismiss: (id: string) => void;
  onDismissAll: () => void;
  onFlyTo?: (lat: number, lon: number) => void;
}

// Stack of fire-alert toasts in the top-right corner of the dashboard.
//
// Each alert:
//   • Stays for 20s, then auto-dismisses (operator can extend by hovering — paused)
//   • Click body → fly map to coordinates (if onFlyTo provided)
//   • × button → dismiss this one
//   • "Clear all" → dismiss whole stack
//
// First-time toast also offers an inline "Enable browser alerts" button so
// users can opt into OS-level Notification API (works when tab is in BG).
const AUTO_DISMISS_MS = 20_000;

export default function AlertToasts({ alerts, onDismiss, onDismissAll, onFlyTo }: Props) {
  const [now, setNow] = useState(() => Date.now());
  const [perm, setPerm] = useState<NotifyPermission>(getNotificationPermission());
  const [hoveredId, setHoveredId] = useState<string | null>(null);

  // Tick once a second for auto-dismiss countdown UI
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, []);

  // Auto-dismiss after timeout (paused while hovered)
  useEffect(() => {
    for (const a of alerts) {
      if (a.dismissed) continue;
      if (hoveredId === a.id) continue;
      if (now - a.detectedAt >= AUTO_DISMISS_MS) onDismiss(a.id);
    }
  }, [alerts, now, hoveredId, onDismiss]);

  const onEnableNotify = async () => {
    const next = await requestNotificationPermission();
    setPerm(next);
  };

  if (alerts.length === 0 && perm === "granted") return null;

  return (
    <div className="alert-toasts" role="region" aria-label="Real-time fire alerts">
      {/* OS Notification permission CTA — shown until granted/denied/unsupported */}
      {perm === "default" && (
        <div className="alert-toast alert-toast-info">
          <div className="alert-toast-body">
            <div className="alert-toast-title">🔔 เปิด Browser Notifications?</div>
            <div className="alert-toast-sub">
              ระบบจะแจ้งเตือนทันทีแม้ปิด tab อยู่ (ใช้ Browser Notification API)
            </div>
          </div>
          <div className="alert-toast-actions">
            <button type="button" className="action-btn primary" onClick={onEnableNotify}>
              เปิด
            </button>
          </div>
        </div>
      )}

      {alerts.length > 1 && (
        <button
          type="button"
          className="alert-toast-clear-all"
          onClick={onDismissAll}
        >
          Clear all ({alerts.length})
        </button>
      )}

      {alerts.map((a) => {
        const elapsedMs = now - a.detectedAt;
        const remainingMs = Math.max(0, AUTO_DISMISS_MS - elapsedMs);
        const progress = hoveredId === a.id ? 100 : (1 - remainingMs / AUTO_DISMISS_MS) * 100;
        return (
          <div
            key={a.id}
            className="alert-toast alert-toast-fire"
            onMouseEnter={() => setHoveredId(a.id)}
            onMouseLeave={() => setHoveredId(null)}
            role="alert"
          >
            <button
              type="button"
              className="alert-toast-close"
              onClick={() => onDismiss(a.id)}
              aria-label="Dismiss alert"
            >×</button>
            <div
              className="alert-toast-body"
              onClick={() => onFlyTo?.(a.lat, a.lon)}
              style={{ cursor: onFlyTo ? "pointer" : "default" }}
              role={onFlyTo ? "button" : undefined}
              tabIndex={onFlyTo ? 0 : undefined}
            >
              <div className="alert-toast-title">
                🔥 ตรวจพบไฟใหม่!
              </div>
              <div className="alert-toast-location">
                <b>{a.province}</b>
                {a.district && a.district !== "—" ? ` · ${a.district}` : ""}
              </div>
              <div className="alert-toast-coords mono">
                {a.lat.toFixed(3)}°, {a.lon.toFixed(3)}°
              </div>
              <div className="alert-toast-meta">
                {a.satellite} · {a.confident && `confidence ${a.confident}`}
                {a.landUse && a.landUse !== "—" ? ` · ${a.landUse}` : ""}
              </div>
              {a.acqDateTime && (
                <div className="alert-toast-time">
                  ตรวจพบ {a.acqDateTime}
                </div>
              )}
            </div>
            <div
              className="alert-toast-progress"
              style={{ width: `${progress}%` }}
              aria-hidden="true"
            />
          </div>
        );
      })}
    </div>
  );
}
