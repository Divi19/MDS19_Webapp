"use client";

import { useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import {
  fetchPathwayDescription,
  type PathwayDescription,
  type PathwayResult,
} from "@/lib/pathways";

type DescState =
  | { status: "loading" }
  | { status: "error" }
  | { status: "done"; data: PathwayDescription };

const rowKey = (r: PathwayResult) => `${r.category}:${r.term}`;

const CATEGORY_CLASS: Record<string, string> = {
  KEGG_PATHWAY: "kegg",
  REACTOME_PATHWAY: "reactome",
  GOTERM_BP_FAT: "gobp",
};

const CATEGORY_LABEL: Record<string, string> = {
  KEGG_PATHWAY: "KEGG",
  REACTOME_PATHWAY: "Reactome",
  GOTERM_BP_FAT: "GO:BP",
};

function logP(p: number): number {
  return -Math.log10(Math.max(p, 1e-12));
}

function formatP(p: number): string {
  return p < 0.001 ? p.toExponential(1) : p.toFixed(3);
}

/** Strips each category's own ID prefix (same rule as the pills). */
function formatTerm(term: string): string {
  const afterTilde = term.split("~");
  if (afterTilde.length > 1) return afterTilde.slice(1).join("~");
  return term.replace(/^[a-zA-Z]+\d+:/, "");
}

/** Full Enrichr result list, sorted by p-value as returned by the backend
 * (for a cluster, the pills' top 3 are its first three rows). Used for a
 * cluster's marker genes and for a single gene; `intro` sits above the table
 * (the gene's description), `status` covers a lookup still in flight. */
export default function PathwayListModal({
  pretitle,
  title = "Pathway enrichment",
  intro,
  status = "done",
  results,
  footer,
  emptyText = "No significant pathways found.",
  onClose,
}: {
  pretitle: string;
  title?: string;
  intro?: ReactNode;
  status?: "loading" | "error" | "done";
  results: PathwayResult[];
  footer?: string;
  emptyText?: string;
  onClose: () => void;
}) {
  // Rows whose description is open, and what has been fetched so far (kept
  // after closing, so reopening is instant).
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [descs, setDescs] = useState<Record<string, DescState>>({});

  function load(r: PathwayResult) {
    const key = rowKey(r);
    setDescs((d) => ({ ...d, [key]: { status: "loading" } }));
    fetchPathwayDescription(r)
      .then((data) => setDescs((d) => ({ ...d, [key]: { status: "done", data } })))
      .catch(() => setDescs((d) => ({ ...d, [key]: { status: "error" } })));
  }

  function toggle(r: PathwayResult) {
    const key = rowKey(r);
    const opening = !open.has(key);
    setOpen((o) => {
      const next = new Set(o);
      if (opening) next.add(key);
      else next.delete(key);
      return next;
    });
    if (opening && (!descs[key] || descs[key].status === "error")) load(r);
  }

  const maxLogP = Math.max(...results.map((r) => logP(r.pvalue)), 1);

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
            <div className="pretitle">{pretitle}</div>
            <h2>{title}</h2>
          </div>
          <button className="modal-close" onClick={onClose} aria-label="Close">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>
        <div className="modal-body pathway-body">
          {intro}
          {status === "loading" && <div className="pathway-status">Looking up pathways…</div>}
          {status === "error" && <div className="pathway-status">Couldn&apos;t load pathways. Try again shortly.</div>}
          {status === "done" && results.length === 0 && <div className="pathway-status">{emptyText}</div>}
          {status === "done" && results.length > 0 && (
          <div className="pathway-table">
          <div className="pathway-row pathway-row-head">
            <span>#</span>
            <span>Term</span>
            <span>Source</span>
            <span>Significance</span>
            <span>p-value</span>
          </div>
          {results.map((r, i) => {
            const key = rowKey(r);
            const isOpen = open.has(key);
            const desc = descs[key];
            return (
            <div
              key={key}
              className={`pathway-row pathway-row-click${isOpen ? " is-open" : ""}`}
              role="button"
              tabIndex={0}
              aria-expanded={isOpen}
              onClick={(e) => {
                // Clicks inside the opened description (text, link) don't toggle.
                if (!(e.target as HTMLElement).closest(".pathway-desc")) toggle(r);
              }}
              onKeyDown={(e) => {
                if (e.target === e.currentTarget && (e.key === "Enter" || e.key === " ")) {
                  e.preventDefault();
                  toggle(r);
                }
              }}
            >
              <span className="pathway-rank">{i + 1}</span>
              <span className="pathway-main">
                <span className="pathway-term">{formatTerm(r.term)}</span>
                <span className="pathway-genes">
                  {r.genes.map((g) => (
                    <span key={g} className="pathway-gene">{g}</span>
                  ))}
                </span>
              </span>
              <span>
                <span className={`pathway-src ${CATEGORY_CLASS[r.category] ?? ""}`}>
                  {CATEGORY_LABEL[r.category] ?? r.category}
                </span>
              </span>
              <span className="bar-track">
                <span className="bar-fill" style={{ width: `${(logP(r.pvalue) / maxLogP) * 100}%` }} />
              </span>
              <span className="pathway-p">
                {formatP(r.pvalue)}
                <span className="pathway-adj">adj {formatP(r.benjamini)}</span>
              </span>
              {isOpen && (
                <div className="pathway-desc">
                  {(!desc || desc.status === "loading") && <span className="pathway-desc-muted">Loading description…</span>}
                  {desc?.status === "error" && (
                    <span className="pathway-desc-muted">
                      Couldn&apos;t load the description.{" "}
                      <button type="button" className="cluster-analysis-viewall" onClick={() => load(r)}>Retry</button>
                    </span>
                  )}
                  {desc?.status === "done" && (
                    <>
                      <span>{desc.data.description ?? "No description available from the source database."}</span>
                      <a href={desc.data.url} target="_blank" rel="noopener noreferrer">
                        {r.category === "KEGG_PATHWAY" ? "Search on KEGG ↗" : "Read more ↗"}
                      </a>
                    </>
                  )}
                </div>
              )}
            </div>
            );
          })}
          </div>
          )}
        </div>
        <div className="modal-footer">
          <div className="hint">
            {footer ??
              `Click a row for its description. ${results.length} terms with p ≤ 0.05 (up to 10 per library), sorted by p-value. Adj. p is Enrichr's Benjamini–Hochberg value.`}
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
