"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CL, type Prediction } from "@/lib/mockPrediction";
import { predict, toPrediction } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { getPredictionResponse, savePrediction } from "@/lib/history";
import AuthModal from "./AuthModal";
import ChatPanel from "./ChatPanel";
import HistoryPanel from "./HistoryPanel";
import ProgressOverlay, { PIPELINE_STEPS } from "./ProgressOverlay";
import SpatialPlot from "./SpatialPlot";
import UploadModal, { type RunPayload } from "./UploadModal";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type View = "clusters" | "genes";

export default function GeneXApp() {
  const { user, enabled: authEnabled, signOut } = useAuth();
  const [authModalOpen, setAuthModalOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [pred, setPred] = useState<Prediction>({
    spots: [],
    genes: [],
    geneMeta: {},
    topGenes: [],
    clusters: [],
    counts: [0, 0, 0, 0, 0],
    total: 0,
  });

  const [ready, setReady] = useState(false);
  const [view, setView] = useState<View>("clusters");
  const [gene, setGene] = useState("ERBB2");
  const [modalOpen, setModalOpen] = useState(false);
  const [geneMenuOpen, setGeneMenuOpen] = useState(false);
  const [geneQuery, setGeneQuery] = useState("");
  const [genePage, setGenePage] = useState(0);
  const [running, setRunning] = useState(false);
  const [stepIndex, setStepIndex] = useState(0);
  const [uploaded, setUploaded] = useState<RunPayload | null>(null);
  const [toast, setToast] = useState("");
  const toastTimer = useRef<number | undefined>(undefined);

  const showToast = useCallback((msg: string) => {
    setToast(msg);
    window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(""), 1800);
  }, []);

  const changeView = useCallback(
    (v: View) => {
      if (ready) setView(v);
    },
    [ready],
  );

  const runPrediction = useCallback(
    async (payload: RunPayload) => {
      if (!payload.file) {
        showToast("Choose an image file before running the real model");
        return;
      }
      setModalOpen(false);
      setUploaded(payload);
      setRunning(true);
      setReady(false);
      setStepIndex(0);
      try {
        setStepIndex(1);
        const response = await predict(payload.file);
        setStepIndex(5);
        const converted = toPrediction(response);
        setPred(converted);
        setGene(converted.topGenes[0]?.name ?? converted.genes[0] ?? "");
        setGenePage(0);
        setStepIndex(PIPELINE_STEPS.length);
        await sleep(250);
        setReady(true);
        showToast("Real model prediction complete");

        if (user) {
          savePrediction(user.id, payload.file, response).catch((error: unknown) => {
            const message = error instanceof Error ? error.message : "Could not save to history";
            showToast(message);
          });
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : "Prediction failed";
        setUploaded(null);
        showToast(message);
      } finally {
        setRunning(false);
      }
    },
    [showToast, user],
  );

  const loadFromHistory = useCallback(
    async (predictionId: string) => {
      try {
        const { response, imageUrl, filename } = await getPredictionResponse(predictionId);
        const converted = toPrediction(response);
        setUploaded({ name: filename ?? "—", sizeLabel: "—", url: imageUrl, file: null });
        setPred(converted);
        setGene(converted.topGenes[0]?.name ?? converted.genes[0] ?? "");
        setGenePage(0);
        setView("clusters");
        setReady(true);
        showToast("Loaded from history");
      } catch (error) {
        const message = error instanceof Error ? error.message : "Could not load that prediction";
        showToast(message);
      }
    },
    [showToast],
  );

  // auto-open the upload modal shortly after load (matches the mock-up)
  useEffect(() => {
    const t = window.setTimeout(() => setModalOpen(true), 350);
    return () => window.clearTimeout(t);
  }, []);

  // keyboard: Esc closes, U opens
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setModalOpen(false);
      const tag = (document.activeElement?.tagName ?? "").toUpperCase();
      if ((e.key === "u" || e.key === "U") && tag !== "INPUT" && tag !== "TEXTAREA") {
        setModalOpen(true);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // The gene dropdown mirrors the full genes table — every gene found in the
  // tissue, same rank order.
  const geneOptions = useMemo(
    () =>
      pred.topGenes
        .filter((g) => pred.geneMeta[g.name])
        .map((g, i) => ({ name: g.name, label: `#${i + 1}` })),
    [pred.topGenes, pred.geneMeta],
  );

  // Substring-filtered view of the dropdown list, capped for rendering — the
  // full list can be hundreds of genes; typing narrows it to any match.
  const geneMatches = useMemo(() => {
    const q = geneQuery.trim().toLowerCase();
    const list = q
      ? geneOptions.filter((o) => o.name.toLowerCase().includes(q))
      : geneOptions;
    return list.slice(0, 60);
  }, [geneOptions, geneQuery]);

  const pickGene = useCallback(
    (name: string) => {
      setGene(name);
      setGeneQuery("");
      setGeneMenuOpen(false);
      changeView("genes");
    },
    [changeView],
  );

  const fileName = uploaded?.name && uploaded.name !== "—" ? uploaded.name : "her2_B1.tiff";

  const GENES_PER_PAGE = 10;
  const geneTotalPages = Math.max(1, Math.ceil(pred.topGenes.length / GENES_PER_PAGE));
  const genePageClamped = Math.min(genePage, geneTotalPages - 1);
  const genePageRows = pred.topGenes.slice(
    genePageClamped * GENES_PER_PAGE,
    genePageClamped * GENES_PER_PAGE + GENES_PER_PAGE,
  );

  const datasetLabel = !ready
    ? ""
    : view === "genes"
      ? (pred.geneMeta[gene]?.label ?? "ERBB2")
      : `k=5 · ${pred.total} spots`;

  return (
    <div className="app">
      <header className="header">
        <div className="logo">
          <svg viewBox="0 0 24 24" fill="none">
            <circle cx="6" cy="6" r="2.4" fill="#fff" />
            <circle cx="12" cy="6" r="2.4" fill="#fff" opacity=".6" />
            <circle cx="18" cy="6" r="2.4" fill="#fff" opacity=".85" />
            <circle cx="6" cy="12" r="2.4" fill="#fff" opacity=".6" />
            <circle cx="12" cy="12" r="2.4" fill="#fff" />
            <circle cx="18" cy="12" r="2.4" fill="#fff" opacity=".7" />
            <circle cx="6" cy="18" r="2.4" fill="#fff" opacity=".85" />
            <circle cx="12" cy="18" r="2.4" fill="#fff" opacity=".6" />
            <circle cx="18" cy="18" r="2.4" fill="#fff" />
          </svg>
        </div>
        <div className="app-title">GeneX</div>
        <div className="header-spacer" />
        <button
          className="header-btn"
          onClick={() =>
            showToast(ready ? "Exported map image + predicted values" : "Run a section first")
          }
        >
          Export
        </button>
        {authEnabled && user ? (
          <>
            <button className="header-btn" onClick={() => setHistoryOpen(true)}>
              History
            </button>
            <button className="header-btn" onClick={() => signOut()} title={user.email ?? undefined}>
              Sign out
            </button>
          </>
        ) : (
          <button className="header-btn" onClick={() => setAuthModalOpen(true)}>
            Sign in
          </button>
        )}
      </header>

      <main className="grid">
        {/* Column 1 — input + prediction */}
        <div className="col col-1">
          <div className="upload-action">
            <button className="upload-btn" onClick={() => setModalOpen(true)}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                <polyline points="17 8 12 3 7 8" />
                <line x1="12" y1="3" x2="12" y2="15" />
              </svg>
              <span>Upload H&amp;E section</span>
              <span className="kbd">U</span>
            </button>
            <button
              className="replace-btn"
              title="Reset session"
              onClick={() => window.location.reload()}
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="1 4 1 10 7 10" />
                <path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10" />
              </svg>
              reset
            </button>
          </div>

          <div className="card">
            <div className="card-title">
              Input section
              <span className="meta">{ready ? fileName : "no file loaded"}</span>
            </div>
            <div className="input-image">
              {ready && uploaded?.url ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={uploaded.url} alt="uploaded H&E section" />
              ) : (
                <div className="empty-hint">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.2">
                    <rect x="3" y="3" width="18" height="18" rx="2" />
                    <circle cx="8.5" cy="8.5" r="1.5" />
                    <polyline points="21 15 16 10 5 21" />
                  </svg>
                  <div className="h">No section uploaded</div>
                  <div className="s">click &quot;Upload H&amp;E section&quot; to begin</div>
                </div>
              )}
            </div>

            {ready ? (
              <div className="alert">
                <span className="pulse" />
                <div className="alert-text">
                  Top predicted gene: {pred.topGenes[0]?.name ?? "unavailable"}
                  <small>returned by the deployed mclSTExp API · not a diagnosis</small>
                </div>
              </div>
            ) : (
              <div className="alert placeholder">
                <span className="pulse" />
                <div className="alert-text">
                  Prediction pending
                  <small>upload a section to run the model</small>
                </div>
              </div>
            )}
          </div>

          <div className="card">
            <div className="card-title">
              Predicted genes
              {ready && <span className="meta">{pred.topGenes.length} in this section</span>}
            </div>
            <table className="gene-table">
              <colgroup>
                <col style={{ width: 60 }} />
                <col style={{ width: 48 }} />
                <col />
                <col style={{ width: 44 }} />
              </colgroup>
              <thead>
                <tr>
                  <th>Gene</th>
                  <th>Value</th>
                  <th>Expression</th>
                  <th>Level</th>
                </tr>
              </thead>
              <tbody>
                {!ready ? (
                  <tr className="empty-row">
                    <td colSpan={4}>no predictions yet — upload a section</td>
                  </tr>
                ) : (
                  (() => {
                    const max = Math.max(...pred.topGenes.map((g) => g.value));
                    return genePageRows.map((g) => {
                      const cls =
                        g.level === "High"
                          ? "level-high"
                          : g.level === "Mid"
                            ? "level-mid"
                            : "level-low";
                      return (
                        <tr
                          key={g.name}
                          className="gene-row"
                          onClick={() => {
                            if (pred.geneMeta[g.name]) {
                              setGene(g.name);
                              changeView("genes");
                            }
                          }}
                        >
                          <td className="gene-name">{g.name}</td>
                          <td className="gene-value">{g.value.toFixed(2)}</td>
                          <td>
                            <div className="bar-track">
                              <div
                                className="bar-fill"
                                style={{ width: `${((g.value / max) * 100).toFixed(0)}%` }}
                              />
                            </div>
                          </td>
                          <td>
                            <span className={`level-tag ${cls}`}>{g.level}</span>
                          </td>
                        </tr>
                      );
                    });
                  })()
                )}
              </tbody>
            </table>
            {ready && geneTotalPages > 1 && (
              <div className="gene-pagination">
                <button
                  className="page-btn"
                  disabled={genePageClamped === 0}
                  onClick={() => setGenePage((p) => Math.max(0, p - 1))}
                >
                  ← Prev
                </button>
                <span className="page-label">
                  Page {genePageClamped + 1} of {geneTotalPages}
                </span>
                <button
                  className="page-btn"
                  disabled={genePageClamped >= geneTotalPages - 1}
                  onClick={() => setGenePage((p) => Math.min(geneTotalPages - 1, p + 1))}
                >
                  Next →
                </button>
              </div>
            )}
          </div>
        </div>

        {/* Column 2 — spatial map + clustering */}
        <div className="col col-2">
          <div className="card plot-card">
            <div className="plot-header">
              <div className="seg">
                <button
                  className={view === "clusters" ? "on" : ""}
                  onClick={() => changeView("clusters")}
                >
                  Clusters
                </button>
                <button
                  className={view === "genes" ? "on" : ""}
                  onClick={() => changeView("genes")}
                >
                  Genes
                </button>
              </div>
              {view === "genes" && (
                <div className="gene-combo">
                  <input
                    className="gsel"
                    placeholder="select a gene"
                    aria-label="gene"
                    value={geneMenuOpen ? geneQuery : gene}
                    onFocus={() => {
                      setGeneQuery("");
                      setGeneMenuOpen(true);
                    }}
                    onClick={() => setGeneMenuOpen(true)}
                    onChange={(e) => {
                      setGeneQuery(e.target.value);
                      setGeneMenuOpen(true);
                    }}
                    onBlur={() => window.setTimeout(() => setGeneMenuOpen(false), 120)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && geneMatches[0]) {
                        e.preventDefault();
                        pickGene(geneMatches[0].name);
                        (e.target as HTMLInputElement).blur();
                      } else if (e.key === "Escape") {
                        setGeneMenuOpen(false);
                      }
                    }}
                  />
                  <span className="gsel-caret" aria-hidden>
                    ▾
                  </span>
                  {geneMenuOpen && geneMatches.length > 0 && (
                    <ul className="gene-menu" role="listbox">
                      {geneMatches.map((o) => (
                        <li
                          key={o.name}
                          role="option"
                          aria-selected={o.name === gene}
                          className={o.name === gene ? "on" : ""}
                          onMouseDown={(e) => {
                            e.preventDefault();
                            pickGene(o.name);
                          }}
                        >
                          <span className="gm-name">{o.name}</span>
                          {o.label && <span className="gm-tag">{o.label}</span>}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              )}
              {datasetLabel && <span className="dataset-label">{datasetLabel}</span>}
            </div>

            <SpatialPlot
              pred={pred}
              ready={ready}
              view={view}
              gene={pred.geneMeta[gene] ? gene : (pred.genes[0] ?? "")}
            />
          </div>

          <div className="card">
            <div className="card-title">
              Cluster breakdown
              <span className="meta">click a gene row or legend to explore</span>
            </div>
            <div className="cluster-grid">
              {ready
                ? CL.map((c, i) => (
                    <div key={i} className="cluster-tile">
                      <div className="head">
                        <span className="dot" style={{ background: c }} />
                        <span className="name">{i}</span>
                      </div>
                      <div className="count" style={{ color: c }}>
                        {pred.counts[i]}
                      </div>
                      <div className="pct">
                        {((pred.counts[i] / pred.total) * 100).toFixed(1)}%
                      </div>
                    </div>
                  ))
                : CL.map((c, i) => (
                    <div key={i} className="cluster-tile">
                      <div className="head">
                        <span className="dot" style={{ background: c }} />
                        <span className="name">{i}</span>
                      </div>
                      <div className="count" style={{ color: "var(--muted2)" }}>
                        —
                      </div>
                      <div className="pct">cluster {i}</div>
                    </div>
                  ))}
            </div>
          </div>
        </div>

        {/* Column 3 — agentic assistant */}
        <ChatPanel pred={ready ? pred : null} />
      </main>

      <UploadModal open={modalOpen} onClose={() => setModalOpen(false)} onRun={runPrediction} />
      <ProgressOverlay visible={running} stepIndex={stepIndex} />
      <AuthModal open={authModalOpen} onClose={() => setAuthModalOpen(false)} />
      <HistoryPanel
        open={historyOpen}
        onClose={() => setHistoryOpen(false)}
        onSelect={loadFromHistory}
      />
      <div className={`toast${toast ? " show" : ""}`}>{toast}</div>
    </div>
  );
}
