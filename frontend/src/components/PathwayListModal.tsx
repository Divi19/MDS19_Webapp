"use client";

import { createPortal } from "react-dom";
import type { PathwayResult } from "@/lib/pathways";

const CATEGORY_LABEL: Record<string, string> = {
  KEGG_PATHWAY: "KEGG",
  REACTOME_PATHWAY: "Reactome",
  GOTERM_BP_FAT: "GO:BP",
};

function formatP(p: number): string {
  return p < 0.001 ? p.toExponential(1) : p.toFixed(3);
}

/** Strips each category's own ID prefix (same rule as the pills). */
function formatTerm(term: string): string {
  const afterTilde = term.split("~");
  if (afterTilde.length > 1) return afterTilde.slice(1).join("~");
  return term.replace(/^[a-zA-Z]+\d+:/, "");
}

/** Full Enrichr result list for one cluster, sorted by p-value as returned
 * by the backend, so the pills' top 3 are its first three rows. */
export default function PathwayListModal({
  cluster,
  results,
  onClose,
}: {
  cluster: number;
  results: PathwayResult[];
  onClose: () => void;
}) {
  // Portal: the glass panel's backdrop-filter would otherwise trap position:fixed.
  return createPortal(
    <div
      className="modal-backdrop visible"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="modal pathway-modal" role="dialog" aria-modal="true">
        <div className="modal-header">
          <div>
            <div className="pretitle">Cluster {cluster} · Enrichr</div>
            <h2>Pathway enrichment</h2>
          </div>
          <button className="modal-close" onClick={onClose} aria-label="Close">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>
        <div className="modal-body">
          <div className="pathway-row pathway-row-head">
            <span>Term</span>
            <span>Source</span>
            <span>p-value</span>
            <span>Adj. p</span>
            <span>Genes</span>
          </div>
          {results.map((r) => (
            <div key={`${r.category}:${r.term}`} className="pathway-row">
              <span className="pathway-term">{formatTerm(r.term)}</span>
              <span className="pathway-src">{CATEGORY_LABEL[r.category] ?? r.category}</span>
              <span>{formatP(r.pvalue)}</span>
              <span>{formatP(r.benjamini)}</span>
              <span className="pathway-genes">{r.genes.join(", ")}</span>
            </div>
          ))}
        </div>
        <div className="modal-footer">
          <div className="hint">
            {results.length} terms with p ≤ 0.05 (up to 10 per library), sorted by p-value. Adj. p is
            Enrichr&apos;s Benjamini–Hochberg value.
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
