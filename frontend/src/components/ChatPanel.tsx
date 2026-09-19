"use client";

import { useState } from "react";

export default function ChatPanel() {
  const [open, setOpen] = useState(false);

  return (
    <aside className={`rule-preview${open ? " open" : ""}`}>
      <button className="rule-preview-toggle" onClick={() => setOpen((value) => !value)} aria-expanded={open}>
        <span><strong>Rule-based preview</strong><small>Legacy assistant · not connected to the expanded response</small></span>
        <i aria-hidden="true">{open ? "−" : "+"}</i>
      </button>
      {open && (
        <div className="rule-preview-body">
          <p>The earlier rule reader remains intentionally isolated while its fixed browser clustering assumptions are replaced. Use the scientific tabs for backend-returned values and methods.</p>
          <span>No generative interpretation is active in this stage.</span>
        </div>
      )}
    </aside>
  );
}
