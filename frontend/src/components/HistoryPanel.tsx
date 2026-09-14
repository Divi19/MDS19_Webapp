"use client";

import { useEffect, useState } from "react";
import { useAuth } from "@/lib/auth";
import { listPredictions, type HistoryEntry } from "@/lib/history";

type Entry = HistoryEntry & { imageUrl: string | null };

function fmtDate(iso: string) {
  const d = new Date(iso);
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" }) +
    " · " +
    d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

export default function HistoryPanel({
  open,
  onClose,
  onSelect,
}: {
  open: boolean;
  onClose: () => void;
  onSelect: (predictionId: string) => void;
}) {
  const { user } = useAuth();
  const [entries, setEntries] = useState<Entry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open || !user) return;
    let cancelled = false;

    queueMicrotask(async () => {
      if (cancelled) return;
      setLoading(true);
      setError(null);
      try {
        const data = await listPredictions(user.id);
        if (!cancelled) setEntries(data);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : "Loading history failed");
      } finally {
        if (!cancelled) setLoading(false);
      }
    });

    return () => {
      cancelled = true;
    };
  }, [open, user]);

  if (!open) return null;

  return (
    <div
      className="modal-backdrop visible"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="modal history-modal" role="dialog" aria-modal="true">
        <div className="modal-header">
          <div>
            <div className="pretitle">Your account</div>
            <h2>Prediction history</h2>
          </div>
          <button className="modal-close" onClick={onClose} aria-label="Close">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>

        <div className="modal-body">
          {loading && <div className="history-empty">Loading…</div>}
          {error && <div className="field-error">{error}</div>}
          {!loading && !error && entries.length === 0 && (
            <div className="history-empty">
              No saved predictions yet — results you run while signed in appear here.
            </div>
          )}

          <div className="history-list">
            {entries.map((e) => (
              <button
                key={e.id}
                className="history-item"
                onClick={() => {
                  onSelect(e.id);
                  onClose();
                }}
              >
                <div className="history-thumb">
                  {e.imageUrl ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={e.imageUrl} alt={e.filename ?? "section"} />
                  ) : (
                    <span>—</span>
                  )}
                </div>
                <div className="history-meta">
                  <div className="history-filename">{e.filename ?? "untitled"}</div>
                  <div className="history-sub">{fmtDate(e.createdAt)}</div>
                </div>
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
