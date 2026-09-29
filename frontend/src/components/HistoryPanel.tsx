"use client";

import { useEffect, useState } from "react";
import { useAuth } from "@/lib/auth";
import { deletePrediction, listPredictions, type HistoryEntry } from "@/lib/history";

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
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);

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

  async function handleDelete(e: React.MouseEvent, entry: Entry) {
    e.stopPropagation();
    if (!window.confirm(`Delete "${entry.filename ?? "this prediction"}"? This can't be undone.`)) {
      return;
    }
    setDeleteError(null);
    setDeletingId(entry.id);
    try {
      await deletePrediction(entry.id, entry.imagePath);
      setEntries((prev) => prev.filter((x) => x.id !== entry.id));
    } catch (err) {
      setDeleteError(err instanceof Error ? err.message : "Delete failed");
    } finally {
      setDeletingId(null);
    }
  }

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
          {deleteError && <div className="field-error">{deleteError}</div>}
          {!loading && !error && entries.length === 0 && (
            <div className="history-empty">
              No saved predictions yet — results you run while signed in appear here.
            </div>
          )}

          <div className="history-list">
            {entries.map((e, index) => (
              <div key={e.id} className="history-item">
                <button
                  className="history-item-main"
                  data-tour={index === 0 ? "history-entry" : undefined}
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
                <button
                  className="history-delete"
                  aria-label={`Delete ${e.filename ?? "this prediction"}`}
                  title="Delete"
                  disabled={deletingId === e.id}
                  onClick={(ev) => handleDelete(ev, e)}
                >
                  {deletingId === e.id ? (
                    "…"
                  ) : (
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <polyline points="3 6 5 6 21 6" />
                      <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                      <line x1="10" y1="11" x2="10" y2="17" />
                      <line x1="14" y1="11" x2="14" y2="17" />
                    </svg>
                  )}
                </button>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
