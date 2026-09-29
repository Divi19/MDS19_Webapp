"use client";

import { useEffect, useRef, useState } from "react";
import { fetchGeneInfo, type GeneInfo } from "@/lib/geneInfo";

export interface PopoverAnchor {
  gene: string;
  x: number; // viewport coords of the clicked element
  top: number;
  bottom: number;
}

// The popover's summary text scrolls internally, so it never needs its
// full 300px to be usable — this is the floor below which "open below"
// stops being viable and it's worth flipping above the click instead.
const MIN_USABLE_HEIGHT = 160;

export default function GenePopover({
  anchor,
  onClose,
}: {
  anchor: PopoverAnchor | null;
  onClose: () => void;
}) {
  const [state, setState] = useState<"loading" | "error" | GeneInfo | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!anchor) return;
    let cancelled = false;
    queueMicrotask(async () => {
      if (cancelled) return;
      setState("loading");
      const info = await fetchGeneInfo(anchor.gene);
      if (!cancelled) setState(info ?? "error");
    });
    return () => {
      cancelled = true;
    };
  }, [anchor]);

  useEffect(() => {
    if (!anchor) return;
    function handlePointer(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    }
    function handleKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    // mousedown, not click — matches the gene-menu dismiss pattern already
    // used elsewhere in this app, and fires before the next click's own
    // handler so it can't immediately reopen itself.
    document.addEventListener("mousedown", handlePointer);
    document.addEventListener("keydown", handleKey);
    return () => {
      document.removeEventListener("mousedown", handlePointer);
      document.removeEventListener("keydown", handleKey);
    };
  }, [anchor, onClose]);

  if (!anchor) return null;

  const width = 280;
  const gap = 6;
  const margin = 12;
  const left = Math.min(Math.max(anchor.x, margin), window.innerWidth - width - margin);

  // Flip above the clicked row only when below is too cramped to be
  // usable at all (and above genuinely has more room) — otherwise a
  // click anywhere but the very bottom of a short panel would flip the
  // popover up over unrelated UI (e.g. the uploaded image preview).
  const roomBelow = window.innerHeight - anchor.bottom - gap - margin;
  const roomAbove = anchor.top - gap - margin;
  const opensUp = roomBelow < MIN_USABLE_HEIGHT && roomAbove > roomBelow;
  const style = opensUp
    ? { left, width, bottom: window.innerHeight - anchor.top + gap, maxHeight: Math.max(MIN_USABLE_HEIGHT, roomAbove) }
    : { left, width, top: anchor.bottom + gap, maxHeight: Math.max(MIN_USABLE_HEIGHT, roomBelow) };

  return (
    <div
      className="gene-popover"
      ref={ref}
      style={style}
      role="dialog"
      aria-label={`${anchor.gene} details`}
      data-tour="gene-popover"
    >
      <button className="gene-popover-close" onClick={onClose} aria-label="Close">
        ×
      </button>
      <div className="gene-popover-symbol">{anchor.gene}</div>
      {state === "loading" && <div className="gene-popover-status">looking up…</div>}
      {state === "error" && (
        <div className="gene-popover-status">no description found for {anchor.gene}</div>
      )}
      {state && typeof state === "object" && (
        <>
          {state.name && state.name.toUpperCase() !== anchor.gene.toUpperCase() && (
            <div className="gene-popover-name">{state.name}</div>
          )}
          <div className="gene-popover-summary">
            {state.summary ?? "No summary available for this gene."}
          </div>
          <div className="gene-popover-source">via mygene.info</div>
        </>
      )}
    </div>
  );
}
