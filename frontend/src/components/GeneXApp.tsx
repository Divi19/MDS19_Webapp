"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { predict } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { downloadBackendBundle, downloadCurrentViewPNG } from "@/lib/export";
import { getPredictionResponse, savePrediction } from "@/lib/history";
import type { PredictionResponse } from "@/lib/types";
import AuthModal from "./AuthModal";
import ChatPanel from "./ChatPanel";
import HistoryPanel from "./HistoryPanel";
import ScientificPanels, { type WorkspaceTab } from "./ScientificPanels";
import SpatialPlot, { type ROIGroup, type ViewerMode } from "./SpatialPlot";
import UploadModal, { type RunPayload } from "./UploadModal";

const TABS: Array<{ id: WorkspaceTab; label: string }> = [
  { id: "overview", label: "Overview" },
  { id: "genes", label: "Genes" },
  { id: "domains", label: "Domains" },
  { id: "roi", label: "ROI" },
  { id: "compare", label: "Compare" },
  { id: "methods", label: "Methods" },
];

function hasExpandedContract(value: unknown): value is PredictionResponse {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<PredictionResponse>;
  return Boolean(
    candidate.prediction_id &&
      Array.isArray(candidate.prediction_tiles) &&
      candidate.model_metadata &&
      candidate.image_metadata &&
      candidate.coordinate_metadata &&
      candidate.qc &&
      candidate.applicability &&
      candidate.all_gene_summary,
  );
}

function failureMessage(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}

export default function GeneXApp() {
  const { user, enabled: authEnabled, signOut } = useAuth();
  const [authModalOpen, setAuthModalOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [modalOpen, setModalOpen] = useState(false);
  const [prediction, setPrediction] = useState<PredictionResponse | null>(null);
  const [uploaded, setUploaded] = useState<RunPayload | null>(null);
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<WorkspaceTab>("overview");
  const [viewerMode, setViewerMode] = useState<ViewerMode>("image");
  const [gene, setGene] = useState("");
  const [geneQuery, setGeneQuery] = useState("");
  const [selectedA, setSelectedA] = useState<number[]>([]);
  const [selectedB, setSelectedB] = useState<number[]>([]);
  const [activeROIGroup, setActiveROIGroup] = useState<ROIGroup | null>(null);
  const [running, setRunning] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [toast, setToast] = useState("");
  const toastTimer = useRef<number | undefined>(undefined);
  const viewerCanvasRef = useRef<HTMLCanvasElement>(null);

  const showToast = useCallback((message: string) => {
    setToast(message);
    window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(""), 3600);
  }, []);

  const applyPrediction = useCallback((response: PredictionResponse, nextImageUrl: string | null) => {
    const firstGene = response.top_genes[0]?.gene_name ?? response.all_gene_summary.genes[0]?.gene_name ?? "";
    setPrediction(response);
    setImageUrl(nextImageUrl);
    setGene(firstGene);
    setGeneQuery("");
    setActiveTab("overview");
    setViewerMode("image");
    setSelectedA([]);
    setSelectedB([]);
    setActiveROIGroup(null);
  }, []);

  const runPrediction = useCallback(async (payload: RunPayload) => {
    if (!payload.file) {
      showToast("Choose an image before submitting the request.");
      return;
    }
    setModalOpen(false);
    setUploaded(payload);
    setRunning(true);
    try {
      const response = await predict(
        payload.file,
        payload.her2PositiveBreastTissueConfirmed,
        payload.heStainConfirmed,
        payload.micronsPerPixel,
      );
      applyPrediction(response, payload.url);
      showToast("Prediction response loaded.");
      if (user) {
        void savePrediction(user.id, payload.file, response)
          .then(() => showToast("Prediction saved to history."))
          .catch((error: unknown) => {
            const message = error instanceof Error ? error.message : "Could not save to history";
            showToast(`Prediction loaded, but history persistence failed: ${message}`);
          });
      }
    } catch (error) {
      setUploaded(null);
      showToast(error instanceof Error ? error.message : "Prediction request failed");
    } finally {
      setRunning(false);
    }
  }, [applyPrediction, showToast, user]);

  const loadFromHistory = useCallback(async (predictionId: string) => {
    try {
      const { response, imageUrl: historyImageUrl, filename } = await getPredictionResponse(predictionId);
      if (!hasExpandedContract(response)) {
        throw new Error("This saved entry does not contain the expanded scientific response required by this workspace.");
      }
      setUploaded({
        name: filename ?? "Saved prediction",
        sizeLabel: "—",
        url: historyImageUrl,
        file: null,
        her2PositiveBreastTissueConfirmed: response.applicability.her2_positive_breast_tissue_confirmed,
        heStainConfirmed: response.applicability.he_stain_confirmed,
        micronsPerPixel: response.image_metadata.microns_per_pixel ?? 0,
        syntheticDemo: response.model_metadata.mode === "demo",
      });
      applyPrediction(response, historyImageUrl);
      setHistoryOpen(false);
      showToast("Saved response loaded.");
    } catch (error) {
      showToast(error instanceof Error ? error.message : "Could not load that saved response");
    }
  }, [applyPrediction, showToast]);

  // auto-open the upload modal shortly after load (matches the mock-up)
  useEffect(() => {
    const timeout = window.setTimeout(() => setModalOpen(true), 250);
    return () => window.clearTimeout(timeout);
  }, []);

  // keyboard: Esc closes, U opens
  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") setModalOpen(false);
      const tag = (document.activeElement?.tagName ?? "").toUpperCase();
      if ((event.key === "u" || event.key === "U") && tag !== "INPUT" && tag !== "TEXTAREA") setModalOpen(true);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // The gene dropdown mirrors the full genes table — every gene found in the
  // tissue, same rank order.
  const geneOptions = useMemo(
    () => prediction?.all_gene_summary.genes.map((item) => item.gene_name) ?? [],
    [prediction],
  );

  // Substring-filtered view of the dropdown list, capped for rendering — the
  // full list can be hundreds of genes; typing narrows it to any match.
  const geneMatches = useMemo(() => {
    const query = geneQuery.trim().toLowerCase();
    return geneOptions.filter((item) => !query || item.toLowerCase().includes(query)).slice(0, 60);
  }, [geneOptions, geneQuery]);

  function changeTab(tab: WorkspaceTab) {
    setActiveTab(tab);
    if (tab === "overview" || tab === "compare" || tab === "methods") setViewerMode("image");
    if (tab === "genes") setViewerMode("gene");
    if (tab === "domains") setViewerMode("domains");
    if (tab === "roi") setActiveROIGroup("A");
  }

  function chooseGene(nextGene: string) {
    if (!geneOptions.includes(nextGene)) return;
    setGene(nextGene);
    setGeneQuery(nextGene);
    setViewerMode("gene");
  }

  function toggleROITile(tileIndex: number, group: ROIGroup) {
    if (group === "A") {
      setSelectedB((items) => items.filter((item) => item !== tileIndex));
      setSelectedA((items) => items.includes(tileIndex) ? items.filter((item) => item !== tileIndex) : [...items, tileIndex]);
    } else {
      setSelectedA((items) => items.filter((item) => item !== tileIndex));
      setSelectedB((items) => items.includes(tileIndex) ? items.filter((item) => item !== tileIndex) : [...items, tileIndex]);
    }
  }

  function clearROI() {
    setSelectedA([]);
    setSelectedB([]);
    setActiveROIGroup(null);
  }

  async function exportCurrentResponse() {
    if (!prediction || running || exporting) return;
    setExporting(true);
    const [bundleResult, pngResult] = await Promise.allSettled([
      downloadBackendBundle(prediction, selectedA, selectedB),
      downloadCurrentViewPNG(viewerCanvasRef.current, prediction.prediction_id),
    ]);
    if (bundleResult.status === "fulfilled" && pngResult.status === "fulfilled") {
      showToast(`Download started for ${bundleResult.value} and ${pngResult.value}.`);
    } else if (bundleResult.status === "rejected" && pngResult.status === "rejected") {
      showToast(`ZIP failed: ${failureMessage(bundleResult.reason)} PNG failed: ${failureMessage(pngResult.reason)}`);
    } else if (bundleResult.status === "rejected") {
      showToast(`PNG download started; ZIP failed: ${failureMessage(bundleResult.reason)}`);
    } else if (pngResult.status === "rejected") {
      showToast(`ZIP download started; PNG failed: ${failureMessage(pngResult.reason)}`);
    }
    setExporting(false);
  }

  return (
    <div className="science-app">
      <header className="science-header">
        <div className="brand-lockup">
          <div className="logo" aria-hidden="true">
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
          <div><strong>GeneX</strong><span>Spatial expression research workspace</span></div>
        </div>
        <div className="header-scope">HER2-positive breast H&amp;E · research use only</div>
        <div className="header-actions">
          <button className="header-btn" onClick={() => setModalOpen(true)}>New prediction <kbd>U</kbd></button>
          <button className="header-btn" onClick={exportCurrentResponse} disabled={!prediction || running || exporting}>{exporting ? "Exporting…" : "Export ZIP + PNG"}</button>
          {authEnabled && user ? (
            <>
              <button className="header-btn" onClick={() => setHistoryOpen(true)}>History</button>
              <button className="header-btn" onClick={() => signOut()} title={user.email ?? undefined}>Sign out</button>
            </>
          ) : <button className="header-btn" onClick={() => setAuthModalOpen(true)}>Sign in</button>}
        </div>
      </header>

      {running && <div className="request-status"><span />Prediction request in progress. The workspace will update when the backend responds.</div>}

      {!prediction ? (
        <main className="empty-workspace">
          <div className="empty-workspace-copy"><span className="eyebrow">Core scientific frontend</span><h1>Inspect model-scale predicted expression over H&amp;E.</h1><p>Submit a scoped research image to review raw prediction tiles, retrieval support, backend predicted-expression domains, ROI effects, and method metadata.</p><button className="primary-action" onClick={() => setModalOpen(true)}>Open research input</button></div>
          <div className="empty-specimen" aria-hidden="true"><div className="specimen-grid">{Array.from({ length: 42 }, (_, index) => <i key={index} />)}</div><span>Awaiting expanded PredictionResponse</span></div>
        </main>
      ) : (
        <main className="workspace-shell">
          <div className="run-strip">
            <div><span className="run-label">Active response</span><strong>{uploaded?.name ?? prediction.prediction_id}</strong></div>
            <dl><div><dt>ID</dt><dd>{prediction.prediction_id}</dd></div><div><dt>Model</dt><dd>{prediction.model_version}</dd></div><div><dt>Mode</dt><dd>{prediction.model_metadata.mode}</dd></div><div><dt>Tiles</dt><dd>{prediction.prediction_tiles.length}</dd></div></dl>
          </div>

          <nav className="workspace-tabs" aria-label="Scientific workspace sections">
            {TABS.map((tab) => <button key={tab.id} className={activeTab === tab.id ? "active" : ""} onClick={() => changeTab(tab.id)}>{tab.label}</button>)}
          </nav>

          <div className="workspace-grid">
            {/* Column 1 — input + prediction */}
            <aside className="workspace-sidebar">
              {imageUrl && (() => {
                // eslint-disable-next-line @next/next/no-img-element
                return <div className="sidebar-image"><img src={imageUrl} alt={uploaded?.syntheticDemo ? "synthetic canvas demo" : "H&E input section"} /></div>;
              })()}
              <div className="sidebar-section">
                <span className="section-kicker">Active gene overlay</span>
                <div className="gene-picker">
                  <input list="gene-options" value={geneQuery || gene} onChange={(event) => setGeneQuery(event.target.value)} onBlur={() => chooseGene(geneQuery)} onKeyDown={(event) => { if (event.key === "Enter") chooseGene(geneQuery); }} aria-label="Select gene overlay" />
                  <datalist id="gene-options">{geneMatches.map((item) => <option key={item} value={item} />)}</datalist>
                  <button onClick={() => chooseGene(geneQuery)}>View</button>
                </div>
                <span className="picker-note">{geneOptions.length} genes in authoritative summary</span>
              </div>
              <div className="sidebar-section">
                <span className="section-kicker">Sample metadata</span>
                <dl className="sidebar-definitions"><div><dt>Image format</dt><dd>{prediction.image_metadata.format}</dd></div><div><dt>Source size</dt><dd>{prediction.image_metadata.width_pixels} × {prediction.image_metadata.height_pixels} px</dd></div><div><dt>Microns per pixel</dt><dd>{prediction.image_metadata.microns_per_pixel ?? "—"}</dd></div><div><dt>Coordinate origin</dt><dd>{prediction.coordinate_metadata.origin}</dd></div></dl>
              </div>
              <div className="sidebar-section scope-panel"><span className="section-kicker">Applicability</span><strong>{prediction.applicability.within_reference_scope ? "Within declared reference scope" : "Outside declared reference scope"}</strong><p>{prediction.applicability.reference_scope}</p></div>
            </aside>

            {/* Column 2 — spatial map + clustering */}
            <div className="workspace-main">
              <SpatialPlot prediction={prediction} imageUrl={imageUrl} mode={viewerMode} gene={gene} onModeChange={setViewerMode} selectedA={selectedA} selectedB={selectedB} activeROIGroup={activeTab === "roi" ? activeROIGroup : null} onTileToggle={toggleROITile} canvasRef={viewerCanvasRef} />
              <ScientificPanels key={prediction.prediction_id} activeTab={activeTab} prediction={prediction} gene={gene} onGeneChange={chooseGene} selectedA={selectedA} selectedB={selectedB} activeROIGroup={activeROIGroup} onActiveROIGroupChange={setActiveROIGroup} onClearROI={clearROI} />
            </div>
          </div>

          {/* Column 3 — agentic assistant */}
          <ChatPanel key={prediction.prediction_id} prediction={prediction} />
        </main>
      )}

      <UploadModal open={modalOpen} onClose={() => setModalOpen(false)} onRun={runPrediction} />
      <AuthModal open={authModalOpen} onClose={() => setAuthModalOpen(false)} />
      <HistoryPanel open={historyOpen} onClose={() => setHistoryOpen(false)} onSelect={loadFromHistory} />
      <div className={`toast${toast ? " show" : ""}`}>{toast}</div>
    </div>
  );
}
