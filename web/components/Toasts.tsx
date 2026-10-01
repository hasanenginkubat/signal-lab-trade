"use client";

import { dismissNotice, useStore } from "@/lib/store";

export function Toasts() {
  const notices = useStore((s) => s.notices);
  return (
    <div className="toasts" aria-live="polite">
      {notices.map((n) => (
        <div key={n.id} className={`toast ${n.level}`} role="status">
          <div onClick={() => dismissNotice(n.id)}>{n.message}</div>
          {n.actions && (
            <div className="toast-actions">
              {n.actions.map((a) => (
                <button
                  key={a.label}
                  className={`btn sm ${a.tone === "long" ? "long" : a.tone === "short" ? "short" : ""}`}
                  onClick={() => {
                    a.run();
                    dismissNotice(n.id);
                  }}
                >
                  {a.label}
                </button>
              ))}
              <button className="btn sm ghost" onClick={() => dismissNotice(n.id)}>
                Kapat
              </button>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
