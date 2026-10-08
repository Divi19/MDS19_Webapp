"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CL, NAMED_GENES, viridis, type Level, type Prediction } from "@/lib/mockPrediction";
import { predict, toPrediction } from "@/lib/api";
import { exportGeneExpressionExcel } from "@/lib/exportExcel";
import { useAuth } from "@/lib/auth";
import { downloadPredictionImage, getPredictionResponse, savePrediction } from "@/lib/history";
import AuthModal from "./AuthModal";
import ClusterAnalysisPanel from "./ClusterAnalysisPanel";
import GenePopover, { type PopoverAnchor } from "./GenePopover";
import GradCamPanel from "./GradCamPanel";
import HistoryPanel from "./HistoryPanel";
import ProfilePanel from "./ProfilePanel";
import ProgressOverlay, { PIPELINE_STEPS } from "./ProgressOverlay";
import SpatialPlot from "./SpatialPlot";
import TissueAnalysisPanel from "./TissueAnalysisPanel";
import TissueComposition from "./TissueComposition";
import TutorialOverlay from "./TutorialOverlay";
import UploadModal, { type RunPayload } from "./UploadModal";
import type { TissueClass } from "@/lib/tissue";
import { TUTORIAL_LOADING_STEP, TUTORIAL_STEPS } from "@/lib/tutorial";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type View = "clusters" | "genes" | "tissue" | "gradcam";
type GeneFilter = "all" | "High" | "Mid" | "Low" | "markers";

function levelClass(level: Level): string {
  return level === "High" ? "level-high" : level === "Mid" ? "level-mid" : "level-low";
}

/** A Google-style sliding window of page numbers, clamped to the valid
 * range and centred on the current page wherever there's room for it. */
function pageWindow(current: number, total: number, size: number) {
  if (total <= size) return Array.from({ length: total }, (_, i) => i + 1);
  let start = Math.max(1, current - Math.floor(size / 2));
  const end = Math.min(total, start + size - 1);
  start = Math.max(1, end - size + 1);
  return Array.from({ length: end - start + 1 }, (_, i) => start + i);
}

export default function GeneXApp() {
  const { user, enabled: authEnabled, signOut } = useAuth();
  const [authModalOpen, setAuthModalOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [profileOpen, setProfileOpen] = useState(false);
  const [accountMenuOpen, setAccountMenuOpen] = useState(false);
  const accountMenuRef = useRef<HTMLDivElement>(null);
  const [popoverAnchor, setPopoverAnchor] = useState<PopoverAnchor | null>(null);
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
  // Once true, GradCamPanel stays mounted (just visually hidden) even when
  // the user switches to another tab — it loads real per-tile Grad-CAM in
  // the background over minutes, and unmounting it on every tab switch
  // used to throw away every loaded tile and the in-flight fetch loop,
  // forcing a full restart on returning to the tab.
  const [gradcamMounted, setGradcamMounted] = useState(false);
  const [showImage, setShowImage] = useState(true);
  // Tissue tab: the pinned tissue type (shared by the map legend and the
  // Tissue Analysis picker), and the type hovered in the analysis panel.
  const [tissuePin, setTissuePin] = useState<TissueClass | null>(null);
  const [tissueHover, setTissueHover] = useState<TissueClass | null>(null);
  // Clusters view: the pinned cluster index (shared by the breakdown tiles
  // and the map legend) — everything outside it fades, same pattern as
  // tissuePin above.
  const [clusterPin, setClusterPin] = useState<number | null>(null);
  const [gene, setGene] = useState("ERBB2");
  const [modalOpen, setModalOpen] = useState(false);
  const [geneMenuOpen, setGeneMenuOpen] = useState(false);
  const [geneQuery, setGeneQuery] = useState("");
  const [geneFilter, setGeneFilter] = useState<GeneFilter>("all");
  const [genePage, setGenePage] = useState(0);
  const [running, setRunning] = useState(false);
  const [stepIndex, setStepIndex] = useState(0);
  const [uploaded, setUploaded] = useState<RunPayload | null>(null);
  // History entries keep only a signed display URL; the original file is
  // retrieved separately so Grad-CAM can re-tile the exact uploaded bytes.
  const [originalImageStatus, setOriginalImageStatus] = useState<"idle" | "loading" | "failed">("idle");
  const loadSeqRef = useRef(0);
  const [toast, setToast] = useState("");
  const toastTimer = useRef<number | undefined>(undefined);
  // Guided tutorial: the current step's id, or null when it is closed.
  // Suspended while the sign-in window it opened is showing.
  const [tutorialStepId, setTutorialStepId] = useState<string | null>(null);
  const [tutorialSuspended, setTutorialSuspended] = useState(false);
  // True while the tutorial waits for a saved analysis it opened to load.
  const [tutorialWaiting, setTutorialWaiting] = useState(false);
  const [historyLoadState, setHistoryLoadState] = useState<"idle" | "loading" | "loaded" | "failed">("idle");
  const tutorialActiveRef = useRef(false);
  const tutorialViewTimer = useRef<number | undefined>(undefined);

  const showToast = useCallback((msg: string) => {
    setToast(msg);
    window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(""), 1800);
  }, []);

  const changeView = useCallback(
    (v: View) => {
      if (!ready) return;
      setView(v);
      if (v === "gradcam") setGradcamMounted(true);
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
      setPopoverAnchor(null);
      setTutorialStepId(null);
      loadSeqRef.current++;
      setOriginalImageStatus("idle");
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
        // A prediction without tissue data has no Tissue tab to stay on.
        if (!converted.tissue) setView((v) => (v === "tissue" ? "clusters" : v));
        setGene(converted.topGenes[0]?.name ?? converted.genes[0] ?? "");
        setTissuePin(null);
        setClusterPin(null);
        setGenePage(0);
        setGeneFilter("all");
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
      const seq = ++loadSeqRef.current;
      setHistoryLoadState("loading");
      try {
        const { response, imageUrl, imagePath, filename } = await getPredictionResponse(predictionId);
        if (seq !== loadSeqRef.current) return;
        const converted = toPrediction(response);
        setUploaded({ name: filename ?? "—", sizeLabel: "—", url: imageUrl, file: null });
        setOriginalImageStatus(imagePath ? "loading" : "failed");
        if (imagePath) {
          downloadPredictionImage(imagePath, filename)
            .then((file) => {
              if (seq !== loadSeqRef.current) return;
              setUploaded((current) => (current ? { ...current, file } : current));
              setOriginalImageStatus("idle");
            })
            .catch(() => {
              if (seq === loadSeqRef.current) setOriginalImageStatus("failed");
            });
        }
        setPred(converted);
        // A prediction without tissue data has no Tissue tab to stay on.
        if (!converted.tissue) setView((v) => (v === "tissue" ? "clusters" : v));
        setGene(converted.topGenes[0]?.name ?? converted.genes[0] ?? "");
        setTissuePin(null);
        setClusterPin(null);
        setGenePage(0);
        setGeneFilter("all");
        setView("clusters");
        setReady(true);
        setHistoryLoadState("loaded");
        showToast("Loaded from history");
      } catch (error) {
        const message = error instanceof Error ? error.message : "Could not load that prediction";
        if (seq === loadSeqRef.current) setHistoryLoadState("failed");
        showToast(message);
      }
    },
    [showToast],
  );

  // Signed-in visitors are taken straight to History; everyone else must
  // sign in first, since History is a core part of the tutorial.
  const tutorialSteps = useMemo(
    () => TUTORIAL_STEPS.filter((step) => step.id !== "sign-in" || !user),
    [user],
  );

  /** Moves the tutorial to a step, first putting the page into the state
   * that step describes (open windows, active view, gene popover). */
  const goToTutorialStep = useCallback(
    (id: string) => {
      setAccountMenuOpen(false);
      setGeneMenuOpen(false);
      setHistoryOpen(id === "history-entry");
      setModalOpen(id === "upload-window" || id === "upload-run");
      setPopoverAnchor(null);
      // Views are switched once the tutorial's glide has finished: redrawing
      // the map (or starting Grad-CAM) mid-animation makes the motion stutter.
      window.clearTimeout(tutorialViewTimer.current);
      const tutorialView: View | null =
        id === "spatial-map" ? "clusters" : id === "genes-view" ? "genes" : id === "gradcam" ? "gradcam" : null;
      if (tutorialView) tutorialViewTimer.current = window.setTimeout(() => changeView(tutorialView), 320);
      if (id === "gene-reference") {
        const chip = document.querySelector<HTMLElement>('[data-tour="cluster-analysis"] .cluster-analysis-gene');
        if (chip?.textContent) {
          const rect = chip.getBoundingClientRect();
          setPopoverAnchor({ gene: chip.textContent, x: rect.left, top: rect.top, bottom: rect.bottom });
        }
      }
      setTutorialSuspended(false);
      setTutorialWaiting(false);
      setTutorialStepId(id);
    },
    [changeView],
  );

  const endTutorial = useCallback(() => {
    window.clearTimeout(tutorialViewTimer.current);
    setTutorialStepId(null);
    setTutorialSuspended(false);
    setTutorialWaiting(false);
    setHistoryOpen(false);
    setModalOpen(false);
    setPopoverAnchor(null);
  }, []);

  const tutorialIndex = tutorialSteps.findIndex((step) => step.id === tutorialStepId);

  const nextTutorialStep = useCallback(() => {
    // Signing in is required to continue: Next opens the sign-in window, and
    // the tutorial resumes at History once the visitor is signed in.
    if (tutorialStepId === "sign-in" && !user) {
      setAuthModalOpen(true);
      return;
    }
    const next = tutorialSteps[tutorialIndex + 1];
    if (next) goToTutorialStep(next.id);
    else endTutorial();
  }, [endTutorial, goToTutorialStep, tutorialIndex, tutorialStepId, tutorialSteps, user]);

  const previousTutorialStep = useCallback(() => {
    const previous = tutorialSteps[tutorialIndex - 1];
    if (previous) goToTutorialStep(previous.id);
  }, [goToTutorialStep, tutorialIndex, tutorialSteps]);

  const handleTutorialTargetActivated = useCallback(
    (stepId: string) => {
      if (stepId !== tutorialStepId) return;
      // Choosing a saved analysis starts a load that takes a few seconds;
      // the tutorial shows a loading card until the result has rendered.
      if (stepId === "history-entry") setTutorialWaiting(true);
      else nextTutorialStep();
    },
    [nextTutorialStep, tutorialStepId],
  );

  // Leave the loading card once the saved analysis has loaded (after a short
  // pause for it to render), return to the History list if it failed, and
  // never wait longer than 20 seconds.
  useEffect(() => {
    if (!tutorialWaiting) return;
    if (historyLoadState === "loaded" || historyLoadState === "failed") {
      const timer = window.setTimeout(
        () => goToTutorialStep(historyLoadState === "loaded" ? "input-card" : "history-entry"),
        150,
      );
      return () => window.clearTimeout(timer);
    }
    const timeout = window.setTimeout(() => goToTutorialStep("input-card"), 20000);
    return () => window.clearTimeout(timeout);
  }, [goToTutorialStep, historyLoadState, tutorialWaiting]);

  // The Sign in step's window sits beneath the tutorial layer, so the
  // tutorial steps aside while it is open, then resumes at History once
  // the visitor is signed in, or back at the Sign in step if they close it.
  useEffect(() => {
    if (tutorialStepId !== "sign-in") return;
    if (user) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- resuming the tutorial once the auth state it was waiting on arrives
      goToTutorialStep("history-button");
    } else {
      setTutorialSuspended(authModalOpen);
    }
  }, [authModalOpen, goToTutorialStep, tutorialStepId, user]);

  useEffect(() => {
    tutorialActiveRef.current = tutorialStepId !== null && !tutorialSuspended;
  }, [tutorialStepId, tutorialSuspended]);

  // Offer the tutorial shortly after the page loads. The upload window is
  // one step away from the tutorial, or from the Upload button.
  useEffect(() => {
    const t = window.setTimeout(() => setTutorialStepId("welcome"), 350);
    return () => window.clearTimeout(t);
  }, []);

  // keyboard: Esc closes, U opens
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (tutorialActiveRef.current) return;
      if (e.key === "Escape") setModalOpen(false);
      const tag = (document.activeElement?.tagName ?? "").toUpperCase();
      if ((e.key === "u" || e.key === "U") && tag !== "INPUT" && tag !== "TEXTAREA") {
        setModalOpen(true);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Dismiss the account menu on an outside click or Escape.
  useEffect(() => {
    if (!accountMenuOpen) return;
    function handlePointer(e: MouseEvent) {
      if (accountMenuRef.current && !accountMenuRef.current.contains(e.target as Node)) {
        setAccountMenuOpen(false);
      }
    }
    function handleKey(e: KeyboardEvent) {
      if (e.key === "Escape") setAccountMenuOpen(false);
    }
    document.addEventListener("mousedown", handlePointer);
    document.addEventListener("keydown", handleKey);
    return () => {
      document.removeEventListener("mousedown", handlePointer);
      document.removeEventListener("keydown", handleKey);
    };
  }, [accountMenuOpen]);

  // The gene dropdown mirrors the full genes table — every gene found in the
  // tissue, same rank order.
  const geneOptions = useMemo(
    () =>
      pred.topGenes
        .filter((g) => pred.geneMeta[g.name])
        .map((g, i) => ({ name: g.name, label: `#${i + 1}`, level: g.level, value: g.value })),
    [pred.topGenes, pred.geneMeta],
  );

  const maxGeneValue = useMemo(
    () => Math.max(...pred.topGenes.map((g) => g.value)) || 1,
    [pred.topGenes],
  );

  // Level/marker filter, then substring search — the full list can be
  // hundreds of genes; either narrows it, both combine.
  const geneMatches = useMemo(() => {
    const q = geneQuery.trim().toLowerCase();
    let list = geneOptions;
    if (geneFilter === "markers") {
      list = list.filter((o) => NAMED_GENES.includes(o.name));
    } else if (geneFilter !== "all") {
      list = list.filter((o) => o.level === geneFilter);
    }
    if (q) list = list.filter((o) => o.name.toLowerCase().includes(q));
    return list.slice(0, 60);
  }, [geneOptions, geneQuery, geneFilter]);

  const pickGene = useCallback(
    (name: string) => {
      setGene(name);
      setGeneQuery("");
      setGeneMenuOpen(false);
      // Reachable from the Genes and Tissue dropdowns (Grad-CAM has no gene
      // selection). The Tissue tab stays put: its bottom card follows the gene.
      if (view !== "tissue") changeView("genes");
    },
    [changeView, view],
  );

  const fileName = uploaded?.name && uploaded.name !== "—" ? uploaded.name : "her2_B1.tiff";

  // Cards or table — user's choice of how the gene panel is presented.
  const [geneView, setGeneView] = useState<"cards" | "table">("table");

  // 8 cards per page normally — but measured and capped, never just assumed.
  // A hardcoded 8 let the fixed-size name/value text outgrow a short screen's
  // available height with nowhere to go, spilling the "High" tag past the
  // card edge. Measuring the tile's natural minimum (swatch at its floor,
  // not however tall it's currently stretched) and capping at 8 means it
  // shows 8 whenever there's room and gracefully fewer when there isn't —
  // never overflow. Table view was already measured the same way.
  const CARDS_MAX = 8;
  const geneListRef = useRef<HTMLDivElement>(null);
  const [cardsPerPage, setCardsPerPage] = useState(CARDS_MAX);
  const [tableRowsPerPage, setTableRowsPerPage] = useState(10);
  const genesPerPage = geneView === "cards" ? cardsPerPage : tableRowsPerPage;

  useEffect(() => {
    const el = geneListRef.current;
    if (!el || !ready) return;

    const recompute = () => {
      const ch = el.clientHeight;
      if (!ch) return;
      const styles = getComputedStyle(el);
      const rowGap = parseFloat(styles.rowGap) || 0;

      if (geneView === "cards") {
        const tile = el.querySelector<HTMLElement>(".gene-tile");
        const name = tile?.querySelector<HTMLElement>(".gene-tile-name");
        const meta = tile?.querySelector<HTMLElement>(".gene-tile-meta");
        const swatch = tile?.querySelector<HTMLElement>(".gene-tile-swatch");
        if (!tile || !name || !meta || !swatch) return;
        const tileStyles = getComputedStyle(tile);
        const swatchMin = parseFloat(getComputedStyle(swatch).minHeight) || 0;
        const padY = parseFloat(tileStyles.paddingTop) + parseFloat(tileStyles.paddingBottom);
        const borderY = parseFloat(tileStyles.borderTopWidth) + parseFloat(tileStyles.borderBottomWidth);
        const innerGap = parseFloat(tileStyles.rowGap) || 0;
        const naturalHeight = swatchMin + name.offsetHeight + meta.offsetHeight + innerGap * 2 + padY + borderY;
        const cols = styles.gridTemplateColumns.split(" ").filter(Boolean).length || 1;
        const rows = Math.max(1, Math.floor((ch + rowGap) / (naturalHeight + rowGap)));
        setCardsPerPage((prev) => {
          const next = Math.min(CARDS_MAX, cols * rows);
          return next > 0 && next !== prev ? next : prev;
        });
      } else {
        const head = el.querySelector<HTMLElement>(".gene-row-head");
        const row = el.querySelector<HTMLElement>(".gene-row");
        if (!row) return;
        const avail = ch - (head?.offsetHeight ?? 0);
        const rows = Math.max(1, Math.floor((avail + rowGap) / (row.offsetHeight + rowGap)));
        setTableRowsPerPage((prev) => (rows > 0 && rows !== prev ? rows : prev));
      }
    };

    recompute();
    const ro = new ResizeObserver(recompute);
    ro.observe(el);
    return () => ro.disconnect();
  }, [ready, pred.topGenes.length, geneView]);

  const geneTotalPages = Math.max(1, Math.ceil(pred.topGenes.length / genesPerPage));
  const genePageClamped = Math.min(genePage, geneTotalPages - 1);
  const genePageRows = pred.topGenes.slice(
    genePageClamped * genesPerPage,
    genePageClamped * genesPerPage + genesPerPage,
  );

  const datasetLabel = !ready
    ? ""
    : view === "genes"
      ? (pred.geneMeta[gene]?.label ?? "ERBB2")
      : view === "tissue" && pred.tissue
        ? pred.tissue.version
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
        <button
          className="tutorial-launch"
          onClick={() => goToTutorialStep("welcome")}
          disabled={running}
          title="Start a guided tutorial of the workspace"
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <circle cx="12" cy="12" r="10" />
            <polygon points="16.24 7.76 14.12 14.12 7.76 16.24 9.88 9.88 16.24 7.76" />
          </svg>
          Take the Tutorial
        </button>
        <div className="header-spacer" />
        <div className="header-actions" data-tour="header-actions">
          <button
            className="header-btn"
            onClick={() => {
              if (!ready || !pred.topGenes.length) {
                showToast("Run a section first");
                return;
              }
              exportGeneExpressionExcel(pred, uploaded?.file?.name);
              showToast(`Exported ${pred.topGenes.length} genes to Excel`);
            }}
          >
            Export
          </button>
          {authEnabled && user ? (
            <>
              <button className="header-btn" data-tour="history" onClick={() => setHistoryOpen(true)}>
                History
              </button>
              <div className="account-menu-wrap" ref={accountMenuRef}>
                <button
                  className="account-avatar"
                  onClick={() => setAccountMenuOpen((v) => !v)}
                  aria-label="Account menu"
                  aria-expanded={accountMenuOpen}
                  title={user.email ?? undefined}
                >
                  {(user.email?.[0] ?? "?").toUpperCase()}
                </button>
                {accountMenuOpen && (
                  <div className="account-menu" role="menu">
                    <div className="account-menu-email">{user.email}</div>
                    <button
                      className="account-menu-item"
                      role="menuitem"
                      onClick={() => {
                        setProfileOpen(true);
                        setAccountMenuOpen(false);
                      }}
                    >
                      Profile
                    </button>
                    <button
                      className="account-menu-item danger"
                      role="menuitem"
                      onClick={() => {
                        signOut();
                        setAccountMenuOpen(false);
                      }}
                    >
                      Sign out
                    </button>
                  </div>
                )}
              </div>
            </>
          ) : (
            <button className="header-btn" data-tour="sign-in" onClick={() => setAuthModalOpen(true)}>
              Sign in
            </button>
          )}
        </div>
      </header>

      <main className="grid">
        {/* Column 1 — input + prediction */}
        <div className="col col-1">
          <div className="upload-action" data-tour="upload-action">
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

          <div className="card input-card" data-tour="input-card">
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

          <div className="card gene-card" data-tour="gene-list">
            <div className="card-title">
              Predicted Gene Expression
              <span
                className="info-icon tooltip-below tooltip-end"
                tabIndex={0}
                data-tooltip="These numbers are predictions, not direct measurements. The model estimates how active each gene is at every spot from the tissue image. Use them to compare which genes and spots are higher or lower, not as exact lab values."
              >
                i
              </span>
            </div>
            {ready && (
              <div className="seg gene-view-seg">
                <button
                  className={geneView === "table" ? "on" : ""}
                  onClick={() => {
                    setGeneView("table");
                    setGenePage(0);
                  }}
                >
                  Table
                </button>
                <button
                  className={geneView === "cards" ? "on" : ""}
                  onClick={() => {
                    setGeneView("cards");
                    setGenePage(0);
                  }}
                >
                  Cards
                </button>
              </div>
            )}
            {!ready ? (
              <div className="empty-row">no predictions yet — upload a section</div>
            ) : (
              (() => {
                const max = maxGeneValue;
                const pick = (
                  g: (typeof genePageRows)[number],
                  e: React.MouseEvent<HTMLButtonElement>,
                ) => {
                  if (pred.geneMeta[g.name]) {
                    setGene(g.name);
                    // On the Tissue tab the gene feeds "Expression by tissue
                    // type", so stay there instead of jumping to Genes.
                    if (view !== "tissue") changeView("genes");
                  }
                  const rect = e.currentTarget.getBoundingClientRect();
                  setPopoverAnchor({ gene: g.name, x: rect.left, top: rect.top, bottom: rect.bottom });
                };

                return geneView === "cards" ? (
                  <div className="gene-grid" ref={geneListRef}>
                    {genePageRows.map((g, index) => (
                      <button
                        key={g.name}
                        className="gene-tile"
                        data-tour={index === 0 ? "gene-first" : undefined}
                        onClick={(e) => pick(g, e)}
                      >
                        <div
                          className="gene-tile-swatch"
                          style={{ background: viridis(g.value / max) }}
                        />
                        <div className="gene-tile-name">{g.name}</div>
                        <div className="gene-tile-meta">
                          <span className="gene-tile-value">{g.value.toFixed(2)}</span>
                          <span className={`level-tag ${levelClass(g.level)}`}>{g.level}</span>
                        </div>
                      </button>
                    ))}
                  </div>
                ) : (
                  <div className="gene-rows" ref={geneListRef}>
                    <div className="gene-row-head">
                      <span>Gene</span>
                      <span>Value</span>
                      <span>Expression</span>
                      <span>Level</span>
                    </div>
                    {genePageRows.map((g, index) => (
                      <button
                        key={g.name}
                        className="gene-row"
                        data-tour={index === 0 ? "gene-first" : undefined}
                        onClick={(e) => pick(g, e)}
                      >
                        <span className="gene-name">{g.name}</span>
                        <span className="gene-value">{g.value.toFixed(2)}</span>
                        <span className="bar-track">
                          <span
                            className="bar-fill"
                            style={{ width: `${((g.value / max) * 100).toFixed(0)}%` }}
                          />
                        </span>
                        <span className={`level-tag ${levelClass(g.level)}`}>{g.level}</span>
                      </button>
                    ))}
                  </div>
                );
              })()
            )}
            {ready && geneTotalPages > 1 && (
              <div className="gene-pagination">
                <button
                  className="page-btn"
                  disabled={genePageClamped === 0}
                  onClick={() => setGenePage(0)}
                  aria-label="First page"
                  title="First page"
                >
                  «
                </button>
                <button
                  className="page-btn"
                  disabled={genePageClamped === 0}
                  onClick={() => setGenePage((p) => Math.max(0, p - 1))}
                  aria-label="Previous page"
                  title="Previous page"
                >
                  ‹
                </button>
                <div className="page-numbers">
                  {pageWindow(genePageClamped + 1, geneTotalPages, 5).map((n) => (
                    <button
                      key={n}
                      className={`page-num${n === genePageClamped + 1 ? " on" : ""}`}
                      onClick={() => setGenePage(n - 1)}
                    >
                      {n}
                    </button>
                  ))}
                </div>
                <button
                  className="page-btn"
                  disabled={genePageClamped >= geneTotalPages - 1}
                  onClick={() => setGenePage((p) => Math.min(geneTotalPages - 1, p + 1))}
                  aria-label="Next page"
                  title="Next page"
                >
                  ›
                </button>
                <button
                  className="page-btn"
                  disabled={genePageClamped >= geneTotalPages - 1}
                  onClick={() => setGenePage(geneTotalPages - 1)}
                  aria-label="Last page"
                  title="Last page"
                >
                  »
                </button>
              </div>
            )}
          </div>
        </div>

        {/* Column 2 — spatial map + clustering */}
        <div className="col col-2">
          <div className="card plot-card" data-tour="plot-card">
            <div className="plot-header">
              <div className="seg seg-tabs">
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
                {ready && pred.tissue && (
                  <button
                    className={view === "tissue" ? "on" : ""}
                    onClick={() => changeView("tissue")}
                  >
                    Tissue
                  </button>
                )}
                <button
                  className={view === "gradcam" ? "on" : ""}
                  onClick={() => changeView("gradcam")}
                >
                  Grad-CAM
                </button>
              </div>
              {(view === "genes" || view === "tissue") && (
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
                  {geneMenuOpen && (
                    <div className="gene-dropdown-panel">
                      <div className="gene-filter-chips">
                        {(["all", "High", "Mid", "Low", "markers"] as GeneFilter[]).map((f) => (
                          <button
                            key={f}
                            type="button"
                            className={geneFilter === f ? "on" : ""}
                            onMouseDown={(e) => e.preventDefault()}
                            onClick={() => setGeneFilter(f)}
                          >
                            {f === "all" ? "All" : f === "markers" ? "Markers" : f}
                          </button>
                        ))}
                      </div>
                      {geneMatches.length > 0 ? (
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
                              <span className="gm-left">
                                <span
                                  className="gm-swatch"
                                  style={{ background: viridis(o.value / maxGeneValue) }}
                                />
                                <span className="gm-name">{o.name}</span>
                              </span>
                              <span className="gm-right">
                                <span className={`level-tag ${levelClass(o.level)}`}>{o.level}</span>
                                <span className="gm-tag">{o.label}</span>
                              </span>
                            </li>
                          ))}
                        </ul>
                      ) : (
                        <div className="gene-menu-empty">no genes match</div>
                      )}
                    </div>
                  )}
                </div>
              )}
              {(view === "genes" || view === "tissue") && uploaded?.url && (
                <label className="overlay-toggle">
                  <input
                    type="checkbox"
                    checked={showImage}
                    onChange={(e) => setShowImage(e.target.checked)}
                  />
                  Show image
                </label>
              )}
              {datasetLabel && <span className="dataset-label">{datasetLabel}</span>}
            </div>
            {gradcamMounted && (
              <GradCamPanel
                pred={pred}
                ready={ready}
                file={uploaded?.file ?? null}
                fileStatus={originalImageStatus}
                imageUrl={uploaded?.url}
                hidden={view !== "gradcam"}
              />
            )}
            {view !== "gradcam" && (
              <SpatialPlot
                pred={pred}
                ready={ready}
                view={view}
                gene={pred.geneMeta[gene] ? gene : (pred.genes[0] ?? "")}
                imageUrl={uploaded?.url}
                showImage={showImage}
                tissuePin={tissuePin}
                onTissuePin={setTissuePin}
                tissueHover={tissueHover}
                clusterPin={clusterPin}
                onClusterPin={setClusterPin}
              />
            )}
          </div>

          {/* The Tissue tab's card is laid over the cluster breakdown (kept in
              place, invisible) so the bottom box — and therefore the map above
              it — is exactly the same height on every tab. */}
          <div className="breakdown-slot">
          {view === "tissue" && ready && pred.tissue && (
            <TissueComposition pred={pred} />
          )}
          <div
            className={`card cluster-card${view === "tissue" && ready && pred.tissue ? " is-covered" : ""}`}
            data-tour="cluster-breakdown"
          >
            <div className="card-title">
              Cluster breakdown
              <span className="meta">click a gene row or legend to explore</span>
            </div>
            <div className="cluster-grid">
              {ready
                ? CL.map((c, i) => (
                    <button
                      key={i}
                      type="button"
                      className={`cluster-tile clickable${clusterPin === i ? " pinned" : ""}`}
                      onClick={() => setClusterPin((prev) => (prev === i ? null : i))}
                    >
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
                    </button>
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
        </div>

        {/* Column 3 — tissue analysis on the Tissue tab, cluster analysis
            everywhere else. Cluster Analysis stays mounted (just hidden) so
            pathway results already fetched survive a visit to the Tissue tab. */}
        {view === "tissue" && ready && pred.tissue && (
          <TissueAnalysisPanel
            pred={pred}
            gene={pred.geneMeta[gene] ? gene : (pred.genes[0] ?? "")}
            onPickGene={setGene}
            pinned={tissuePin}
            onPin={setTissuePin}
            onHoverType={setTissueHover}
          />
        )}
        <ClusterAnalysisPanel
          pred={pred}
          ready={ready}
          hidden={view === "tissue" && ready && !!pred.tissue}
          onGeneClick={(name, rect) =>
            setPopoverAnchor({ gene: name, x: rect.left, top: rect.top, bottom: rect.bottom })
          }
        />
      </main>

      <UploadModal open={modalOpen} onClose={() => setModalOpen(false)} onRun={runPrediction} />
      <ProgressOverlay visible={running} stepIndex={stepIndex} />
      <AuthModal open={authModalOpen} onClose={() => setAuthModalOpen(false)} />
      <HistoryPanel
        open={historyOpen}
        onClose={() => setHistoryOpen(false)}
        onSelect={loadFromHistory}
      />
      <ProfilePanel open={profileOpen} onClose={() => setProfileOpen(false)} />
      <GenePopover anchor={popoverAnchor} onClose={() => setPopoverAnchor(null)} />
      <div className={`toast${toast ? " show" : ""}`}>{toast}</div>
      {tutorialStepId && !tutorialSuspended && tutorialIndex >= 0 && (() => {
        const step = tutorialSteps[tutorialIndex];
        const chapterSteps = tutorialSteps.filter((item) => item.chapter === step.chapter);
        return (
          <TutorialOverlay
            view={{
              step: tutorialWaiting ? TUTORIAL_LOADING_STEP : step,
              stepNumber: tutorialIndex + 1,
              stepCount: tutorialSteps.length,
              chapterStepNumber: chapterSteps.indexOf(step) + 1,
              chapterStepCount: chapterSteps.length,
              waiting: tutorialWaiting,
            }}
            onNext={nextTutorialStep}
            onBack={previousTutorialStep}
            onSkip={endTutorial}
            onTargetActivated={handleTutorialTargetActivated}
          />
        );
      })()}
    </div>
  );
}
