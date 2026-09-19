"use client";

export default function ProgressOverlay({ visible }: { visible: boolean }) {
  return (
    <div className={`progress-overlay${visible ? " visible" : ""}`} aria-hidden={!visible}>
      <div className="progress-card" role="status" aria-live="polite">
        <h3>Request in progress</h3>
        <div className="sub">Awaiting the backend response. Internal processing stages are not reported.</div>
        <div className="request-status"><span />The workspace will update when the request completes.</div>
      </div>
    </div>
  );
}
