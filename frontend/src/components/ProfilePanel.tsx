"use client";

import { useEffect, useState } from "react";
import { useAuth } from "@/lib/auth";
import { countPredictions, getProfile, saveProfile } from "@/lib/profile";

const ROLES = ["Researcher", "Pathologist", "Student", "Other"];

function fmtDate(iso: string) {
  return new Date(iso).toLocaleDateString(undefined, { month: "short", year: "numeric" });
}

export default function ProfilePanel({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { user } = useAuth();
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [predictionCount, setPredictionCount] = useState(0);

  const [displayName, setDisplayName] = useState("");
  const [institution, setInstitution] = useState("");
  const [role, setRole] = useState("");
  const [profileBusy, setProfileBusy] = useState(false);
  const [profileError, setProfileError] = useState<string | null>(null);
  const [profileSaved, setProfileSaved] = useState(false);

  // Reloads fresh every time the panel opens, same pattern as HistoryPanel —
  // simpler than tracking whether a previous load is still valid, and a
  // profile is small enough that refetching on every open is cheap.
  useEffect(() => {
    if (!open || !user) return;
    let cancelled = false;

    queueMicrotask(async () => {
      if (cancelled) return;
      setLoading(true);
      setLoadError(null);
      setProfileError(null);
      setProfileSaved(false);
      try {
        const [profile, count] = await Promise.all([
          getProfile(user.id),
          countPredictions(user.id),
        ]);
        if (cancelled) return;
        setDisplayName(profile?.displayName ?? "");
        setInstitution(profile?.institution ?? "");
        setRole(profile?.role ?? "");
        setPredictionCount(count);
      } catch (e) {
        if (!cancelled) setLoadError(e instanceof Error ? e.message : "Loading profile failed");
      } finally {
        if (!cancelled) setLoading(false);
      }
    });

    return () => {
      cancelled = true;
    };
  }, [open, user]);

  if (!open || !user) return null;

  async function submitProfile() {
    if (!user) return;
    setProfileBusy(true);
    setProfileError(null);
    setProfileSaved(false);
    try {
      await saveProfile(user.id, { displayName, institution, role });
      setProfileSaved(true);
    } catch (e) {
      setProfileError(e instanceof Error ? e.message : "Saving profile failed");
    } finally {
      setProfileBusy(false);
    }
  }

  return (
    <div
      className="modal-backdrop visible"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="modal profile-modal" role="dialog" aria-modal="true">
        <div className="modal-header">
          <div>
            <div className="pretitle">Your account</div>
            <h2>Profile</h2>
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
          {loadError && <div className="field-error">{loadError}</div>}

          {!loading && !loadError && (
            <>
              <div className="profile-stats">
                <div className="profile-stat">
                  <span className="profile-stat-value">{predictionCount}</span>
                  <span className="profile-stat-label">predictions run</span>
                </div>
                <div className="profile-stat">
                  <span className="profile-stat-value">
                    {user.created_at ? fmtDate(user.created_at) : "—"}
                  </span>
                  <span className="profile-stat-label">member since</span>
                </div>
              </div>

              <label className="field">
                <span className="field-label">Email</span>
                <input value={user.email ?? ""} disabled />
              </label>
              <label className="field">
                <span className="field-label">Display name</span>
                <input
                  value={displayName}
                  onChange={(e) => setDisplayName(e.target.value)}
                  placeholder="e.g. Dr. Chris Law"
                  disabled={profileBusy}
                />
              </label>
              <label className="field">
                <span className="field-label">Institution</span>
                <input
                  value={institution}
                  onChange={(e) => setInstitution(e.target.value)}
                  placeholder="e.g. Monash University"
                  disabled={profileBusy}
                />
              </label>
              <label className="field">
                <span className="field-label">Role</span>
                <select value={role} onChange={(e) => setRole(e.target.value)} disabled={profileBusy}>
                  <option value="">—</option>
                  {ROLES.map((r) => (
                    <option key={r} value={r}>
                      {r}
                    </option>
                  ))}
                </select>
              </label>

              {profileError && <div className="field-error">{profileError}</div>}
              {profileSaved && <div className="field-info">Profile saved</div>}

              <div className="profile-actions">
                <button className="run-btn" onClick={submitProfile} disabled={profileBusy}>
                  {profileBusy ? "Saving…" : "Save profile"}
                </button>
              </div>
            </>
          )}
        </div>

        <div className="modal-footer">
          <span className="hint" />
          <button className="btn-secondary" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
