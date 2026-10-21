"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CL, NAMED_GENES, viridis, type Level, type Prediction } from "@/lib/mockPrediction";
import { predict, toPrediction } from "@/lib/api";
import { gradcamAvailable } from "@/lib/cancer";
import { analyzeClusters } from "@/lib/clusterAnalysis";
import { useAuth } from "@/lib/auth";
import { downloadPredictionImage, getPredictionResponse, savePrediction } from "@/lib/history";
import { fetchPathways, type PathwayState } from "@/lib/pathways";
import { generateReportPdf, reportFileName } from "@/lib/pdfReport";
import AuthModal from "./AuthModal";
import ClusterAnalysisPanel from "./ClusterAnalysisPanel";
import GenePathwayModal from "./GenePathwayModal";
import GenePopover, { type PopoverAnchor } from "./GenePopover";
import GradCamPanel, { type GradCamHandle, type GradCamStatus } from "./GradCamPanel";
import HistoryPanel from "./HistoryPanel";
import ProfilePanel from "./ProfilePanel";
import ProgressOverlay, { PIPELINE_STEPS } from "./ProgressOverlay";
import SpatialPlot from "./SpatialPlot";
import TissueAnalysisPanel, { type TissueGroup } from "./TissueAnalysisPanel";
import TissueBreakdown from "./TissueBreakdown";
import TutorialOverlay from "./TutorialOverlay";
import TissueThumb from "./TissueThumb";
import UploadModal, { type RunPayload } from "./UploadModal";
import {
  clusterTissueLabels, geneHomeTissue, TISSUE_COLORS, TISSUE_SHORT_NAMES, type GeneTissue, type TissueClass,
} from "@/lib/tissue";
import { buildTourSteps, DEFAULT_PHASE_MS, pickTourPathwayCluster, tourTarget, TUTORIAL_NO_RESULT_STEP } from "@/lib/tutorial";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The gene list's Cancer toggle as it is on screen (null when the result has
 * none). The tutorial reads and sets it through the page, since its state is
 * declared far below the tutorial's callbacks. */
const cancerToggle = () =>
  document.querySelector<HTMLInputElement>('[data-tour="cancer-filter"] input[type="checkbox"]');
/** Sets that toggle the way the presenter would: by clicking it. */
const setCancerToggle = (on: boolean) => {
  const box = cancerToggle();
  if (box && box.checked !== on) box.click();
};

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
  // Gene whose pathway table is open (from the gene popover); null = closed.
  const [genePathwayModal, setGenePathwayModal] = useState<string | null>(null);
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
  // Home: shows the landing page again on top of the current results.
  const [landingOpen, setLandingOpen] = useState(false);
  const showLanding = !ready || landingOpen;
  const [view, setView] = useState<View>("clusters");
  // Once true, GradCamPanel stays mounted (just visually hidden) even when
  // the user switches to another tab — it loads real per-tile Grad-CAM in
  // the background over minutes, and unmounting it on every tab switch
  // used to throw away every loaded tile and the in-flight fetch loop,
  // forcing a full restart on returning to the tab. Set when a fresh
  // prediction finishes (runPrediction), or on first visit to the tab for a
  // run reopened from History — History runs don't auto-start it, so
  // browsing old runs doesn't spend GPU time on slides nobody asked to explain.
  const [gradcamMounted, setGradcamMounted] = useState(false);
  // Grad-CAM is offered only for the cancers it is verified for (lib/cancer.ts).
  const gradcamOk = gradcamAvailable(pred.cancer);
  const [showImage, setShowImage] = useState(true);
  // Tissue tab: the pinned tissue type (shared by the map legend and the
  // Tissue Analysis picker), and the type hovered in the analysis panel.
  const [tissuePin, setTissuePin] = useState<TissueClass | null>(null);
  const [tissueHover, setTissueHover] = useState<TissueClass | null>(null);
  const [tissueGroupHover, setTissueGroupHover] = useState<TissueGroup | null>(null);
  const [tissueClusterHover, setTissueClusterHover] = useState<number | null>(null);
  // Tissue tab: a cluster locked from the Composition tab. Only one lock at a
  // time: locking a cluster releases a tissue-type pin and vice versa.
  const [tissueClusterPin, setTissueClusterPin] = useState<number | null>(null);
  const pinTissueType = useCallback((cls: TissueClass | null) => {
    setTissuePin(cls);
    if (cls) setTissueClusterPin(null);
  }, []);
  const pinTissueCluster = useCallback((cluster: number | null) => {
    setTissueClusterPin(cluster);
    if (cluster != null) setTissuePin(null);
  }, []);
  // Clusters view: the pinned cluster index (shared by the breakdown tiles
  // and the map legend) — everything outside it fades, same pattern as
  // tissuePin above.
  const [clusterPin, setClusterPin] = useState<number | null>(null);
  // Keyed by cluster index. Lives here (not in ClusterAnalysisPanel) so the
  // PDF report export can read already-fetched results instead of
  // re-querying the pathway service — see the pathways effect below.
  const [pathways, setPathways] = useState<Record<number, PathwayState>>({});
  const gradcamRef = useRef<GradCamHandle>(null);
  const [gradcamStatus, setGradcamStatus] = useState<GradCamStatus>({
    loading: false,
    loadedCount: 0,
    total: 0,
    ready: false,
  });
  const [exportingPdf, setExportingPdf] = useState(false);
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
  const [tutorialStepId, setTutorialStepId] = useState<string | null>(null);
  // A step with two moments (the gene map, the pathway table) starts on its
  // first target and moves to the second by itself.
  const [tourPhase, setTourPhase] = useState(0);
  // Tissue Analysis sub-view and the cluster whose pathway table is open.
  // Held here (not in their panels) so the tutorial can drive them.
  const [tissueTab, setTissueTab] = useState<"expression" | "composition">("expression");
  const [pathwayModal, setPathwayModal] = useState<number | null>(null);
  // What the presenter had on screen when the tour started, put back when it
  // ends or is dismissed.
  const tourSnapshot = useRef<{
    view: View;
    gene: string;
    tissueTab: "expression" | "composition";
    tissuePin: TissueClass | null;
    tissueClusterPin: number | null;
    /** The gene list's "Show Cancer-type genes" toggle; null when it has none. */
    onlyCancer: boolean | null;
  } | null>(null);
  const tutorialActiveRef = useRef(false);
  const tutorialViewTimer = useRef<number | undefined>(undefined);

  const clusterAnalysis = useMemo(() => (ready ? analyzeClusters(pred) : []), [pred, ready]);

  // Pathway lookups fire automatically as soon as a prediction's clusters
  // are known. Lives here (not ClusterAnalysisPanel) so the PDF export
  // can read these same results instead of re-querying the pathway service.
  //
  // Cluster index alone doesn't identify which prediction a lookup belongs
  // to — "cluster 2" in one upload has nothing to do with "cluster 2" in
  // the next — so every new `clusterAnalysis` (keyed off pred+ready)
  // replaces the whole map rather than merging into it.
  useEffect(() => {
    if (!clusterAnalysis.length) {
      queueMicrotask(() => setPathways({}));
      return;
    }
    let cancelled = false;
    queueMicrotask(() => {
      if (cancelled) return;
      setPathways(() => {
        const next: Record<number, PathwayState> = {};
        clusterAnalysis.forEach((a) => {
          next[a.index] = a.markers.length ? { status: "loading" } : { status: "done", results: [] };
        });
        return next;
      });
      clusterAnalysis.forEach((a) => {
        if (!a.markers.length) return;
        fetchPathways(a.markers.map((m) => m.name))
          .then((results) => {
            if (cancelled) return;
            setPathways((prev) => ({ ...prev, [a.index]: { status: "done", results } }));
          })
          .catch((e) => {
            if (cancelled) return;
            const message = e instanceof Error ? e.message : "Pathway lookup failed";
            setPathways((prev) => ({ ...prev, [a.index]: { status: "error", message } }));
          });
      });
    });
    return () => {
      cancelled = true;
    };
  }, [clusterAnalysis]);

  const retryPathways = useCallback(
    (index: number) => {
      const a = clusterAnalysis.find((c) => c.index === index);
      if (!a || !a.markers.length) return;
      setPathways((prev) => ({ ...prev, [index]: { status: "loading" } }));
      fetchPathways(a.markers.map((m) => m.name))
        .then((results) => setPathways((prev) => ({ ...prev, [index]: { status: "done", results } })))
        .catch((e) => {
          const message = e instanceof Error ? e.message : "Pathway lookup failed";
          setPathways((prev) => ({ ...prev, [index]: { status: "error", message } }));
        });
    },
    [clusterAnalysis],
  );

  const showToast = useCallback((msg: string) => {
    setToast(msg);
    window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(""), 1800);
  }, []);

  const changeView = useCallback(
    (v: View) => {
      if (!ready) return;
      setLandingOpen(false);
      setView(v);
      // Hover highlights from the Tissue Analysis panel never get their
      // mouse-leave once the panel unmounts, so clear them on every switch.
      setTissueHover(null);
      setTissueGroupHover(null);
      setTissueClusterHover(null);
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
      setLandingOpen(false);
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
        // Nor one whose cancer has no Grad-CAM yet a Grad-CAM tab.
        if (!gradcamAvailable(converted.cancer)) setView((v) => (v === "gradcam" ? "clusters" : v));
        setGene(converted.topGenes[0]?.name ?? converted.genes[0] ?? "");
        setTissuePin(null);
        setTissueClusterPin(null);
        setClusterPin(null);
        setGenePage(0);
        setGeneFilter("all");
        setStepIndex(PIPELINE_STEPS.length);
        await sleep(250);
        setReady(true);
        // Prediction is on screen; now start Grad-CAM in the background
        // (GradCamPanel mounts hidden and loads batch by batch) so it is
        // usually done by the time the Grad-CAM tab is opened or the PDF
        // is exported, instead of only starting on the first tab click.
        if (gradcamAvailable(converted.cancer)) setGradcamMounted(true);
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
      setLandingOpen(false);
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
        setTissueClusterPin(null);
        setClusterPin(null);
        setGenePage(0);
        setGeneFilter("all");
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

  // The full PDF report embeds a Grad-CAM snapshot, so export is blocked
  // until that panel has actually finished for this prediction — it starts
  // when the prediction finishes (or on visiting the tab for a History run;
  // GeneXApp.gradcamMounted), and gradcamStatus.ready only flips true once
  // it completes.
  const exportPdfReport = useCallback(async () => {
    if (!ready || !pred.topGenes.length) {
      showToast("Run a section first");
      return;
    }
    // A cancer without Grad-CAM (see gradcamOk) exports without that section.
    let snapshot: string | null = null;
    if (gradcamOk) {
      if (!gradcamMounted) {
        showToast("Open the Grad-CAM tab first — the report needs it to finish before it can be generated");
        return;
      }
      if (gradcamStatus.loading) {
        const pct = gradcamStatus.total ? Math.round((gradcamStatus.loadedCount / gradcamStatus.total) * 100) : 0;
        showToast(`Grad-CAM is still computing (${pct}%) — try again once it finishes`);
        return;
      }
      if (!gradcamStatus.ready) {
        showToast("Grad-CAM hasn't finished for this section yet — open the Grad-CAM tab and wait for it to complete");
        return;
      }
      snapshot = gradcamRef.current?.getSnapshot() ?? null;
      if (!snapshot) {
        showToast("Could not capture the Grad-CAM map — try reopening the Grad-CAM tab");
        return;
      }
    }
    setExportingPdf(true);
    try {
      const blob = await generateReportPdf({
        sampleName: uploaded?.name ?? uploaded?.file?.name ?? "section",
        generatedAt: new Date(),
        pred,
        analysis: clusterAnalysis,
        pathways,
        gradcamImage: snapshot,
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = reportFileName(uploaded?.name ?? uploaded?.file?.name ?? "section");
      a.click();
      URL.revokeObjectURL(url);
      showToast("Report exported");
    } catch (error) {
      const message = error instanceof Error ? error.message : "Could not generate the report";
      showToast(message);
    } finally {
      setExportingPdf(false);
    }
  }, [ready, pred, gradcamOk, gradcamMounted, gradcamStatus, uploaded, clusterAnalysis, pathways, showToast]);

  // The cluster whose pathways the tour shows; null while no cluster has any.
  const tourPathwayCluster = useMemo(() => pickTourPathwayCluster(pathways), [pathways]);

  // The tour walks a loaded result; without one it is a single notice card.
  const tutorialSteps = useMemo(
    () =>
      ready
        ? buildTourSteps({ tissue: !!pred.tissue, gradcam: gradcamOk, pathways: tourPathwayCluster !== null })
        : [TUTORIAL_NO_RESULT_STEP],
    [ready, pred.tissue, gradcamOk, tourPathwayCluster],
  );

  /** Moves the tutorial to a step, first putting the page into the state
   * that step describes (active view, Tissue sub-view). Anything the previous
   * step opened (the pathway table) is closed. */
  const goToTutorialStep = useCallback(
    (id: string) => {
      setAccountMenuOpen(false);
      setGeneMenuOpen(false);
      setPopoverAnchor(null);
      setPathwayModal(null);
      setTourPhase(0);
      // The Gene pathways window shows only on its own step, for the first
      // gene in the list as it is now (the gene list marks that row).
      const firstRow = document.querySelector<HTMLElement>('[data-tour="gene-first"]');
      const firstGene = firstRow?.querySelector(".gene-name, .gene-tile-name")?.textContent?.trim() || null;
      setGenePathwayModal(id === "gene-pathways" ? firstGene : null);
      if (id === "gene-list") {
        setGenePage(0);
        // The Cancer toggle goes back to how the presenter had it, so the
        // step plays the same way each time it is visited.
        const start = tourSnapshot.current?.onlyCancer;
        if (start != null) setCancerToggle(start);
      }
      if (id === "tissue-expression") setTissueTab("expression");
      if (id === "tissue-composition") setTissueTab("composition");
      // Views are switched once the tutorial's glide has finished: redrawing
      // the map (or starting Grad-CAM) mid-animation makes the motion stutter.
      window.clearTimeout(tutorialViewTimer.current);
      const tutorialView: View | null =
        id === "clusters" || id === "cluster-analysis" || id === "pathways"
          ? "clusters"
          : id === "tissue-expression" || id === "tissue-composition"
            ? "tissue"
            : id === "gradcam"
              ? "gradcam"
              : null;
      if (tutorialView) tutorialViewTimer.current = window.setTimeout(() => changeView(tutorialView), 320);
      setTutorialStepId(id);
    },
    [changeView],
  );

  /** What a two-moment step shows in its later moments. */
  const runTourPhase = useCallback(
    (id: string, phase: number) => {
      if (phase < 1) return;
      if (id === "gene-map") {
        // The click goes through the gene list itself, so the highlighted row
        // is the gene that gets mapped.
        const row = document.querySelector<HTMLElement>('[data-tour="gene-first"]');
        if (row) row.click();
        else if (pred.topGenes[0]) setGene(pred.topGenes[0].name);
        changeView("genes");
      } else if (id === "pathways") {
        setPathwayModal(tourPathwayCluster);
      } else if (id === "gene-list") {
        setCancerToggle(true);
      }
    },
    [changeView, pred.topGenes, tourPathwayCluster],
  );

  useEffect(() => {
    const step = tutorialSteps.find((item) => item.id === tutorialStepId);
    if (!step?.phases || tourPhase >= step.phases.length - 1) return;
    const timer = window.setTimeout(() => {
      const next = tourPhase + 1;
      runTourPhase(step.id, next);
      setTourPhase(next);
    }, step.phaseMs ?? DEFAULT_PHASE_MS);
    return () => window.clearTimeout(timer);
  }, [runTourPhase, tourPhase, tutorialStepId, tutorialSteps]);

  /** Closes the tour and puts back what the tour changed: the view, the
   * selected gene, the Tissue sub-view and pins, and anything it opened. */
  const endTutorial = useCallback(() => {
    window.clearTimeout(tutorialViewTimer.current);
    setTutorialStepId(null);
    setTourPhase(0);
    setPathwayModal(null);
    setGenePathwayModal(null);
    setPopoverAnchor(null);
    const snapshot = tourSnapshot.current;
    tourSnapshot.current = null;
    if (snapshot) {
      if (snapshot.onlyCancer != null) setCancerToggle(snapshot.onlyCancer);
      setTissueTab(snapshot.tissueTab);
      setTissuePin(snapshot.tissuePin);
      setTissueClusterPin(snapshot.tissueClusterPin);
      setGene(snapshot.gene);
      changeView(snapshot.view);
    }
  }, [changeView]);

  /** Take the Tutorial: the tour of the loaded result, or a notice when there
   * is none. */
  const startTutorial = useCallback(() => {
    setAccountMenuOpen(false);
    setGeneMenuOpen(false);
    setHistoryOpen(false);
    setModalOpen(false);
    setPopoverAnchor(null);
    if (!ready) {
      setTutorialStepId(TUTORIAL_NO_RESULT_STEP.id);
      return;
    }
    setLandingOpen(false);
    tourSnapshot.current = {
      view,
      gene,
      tissueTab,
      tissuePin,
      tissueClusterPin,
      onlyCancer: cancerToggle()?.checked ?? null,
    };
    goToTutorialStep(tutorialSteps[0].id);
  }, [gene, goToTutorialStep, ready, tissueClusterPin, tissuePin, tissueTab, tutorialSteps, view]);

  const tutorialIndex = tutorialSteps.findIndex((step) => step.id === tutorialStepId);

  // A step the result can no longer show (its pathways went away) ends the tour
  // instead of leaving the page blocked behind nothing.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- closing the tour when the result stops offering the step it is on
    if (tutorialStepId !== null && tutorialIndex < 0) endTutorial();
  }, [endTutorial, tutorialIndex, tutorialStepId]);

  const nextTutorialStep = useCallback(() => {
    const next = tutorialSteps[tutorialIndex + 1];
    if (next) goToTutorialStep(next.id);
    else endTutorial();
  }, [endTutorial, goToTutorialStep, tutorialIndex, tutorialSteps]);

  const previousTutorialStep = useCallback(() => {
    const previous = tutorialSteps[tutorialIndex - 1];
    if (previous) goToTutorialStep(previous.id);
  }, [goToTutorialStep, tutorialIndex, tutorialSteps]);

  useEffect(() => {
    tutorialActiveRef.current = tutorialStepId !== null;
  }, [tutorialStepId]);

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

  // Tissue name per expression cluster ("Cancer (95%)"), from the tissue
  // classifier; all null when the prediction has no tissue data.
  const clusterLabels = useMemo(() => clusterTissueLabels(pred), [pred]);
  // For the gene list: the tissue type each gene is clearly highest in (same
  // rule as "Genes higher in" on the Tissue tab); null without tissue data.
  const geneHome = useMemo(() => (pred.tissue ? geneHomeTissue(pred) : null), [pred]);

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

  /** Selects a gene on the map: the Genes tab, or in place on the Tissue tab,
   * where the gene feeds "Expression by tissue type". */
  const showGeneOnMap = useCallback(
    (name: string) => {
      if (!pred.geneMeta[name]) return;
      setGene(name);
      if (view !== "tissue") changeView("genes");
    },
    [pred, view, changeView],
  );

  /** The gene pathway table's button: always lands on the Genes tab showing
   * just this gene, whatever tab the table was opened from, with any cluster
   * highlight cleared so no spots are faded out. */
  const exploreGeneInGenesTab = useCallback(
    (name: string) => {
      if (!pred.geneMeta[name]) return;
      setGene(name);
      setClusterPin(null);
      changeView("genes");
    },
    [pred, changeView],
  );

  const pickGene = useCallback(
    (name: string) => {
      setGene(name);
      setGeneQuery("");
      setGeneMenuOpen(false);
      // The header picker is on every tab and never switches tab: Genes and
      // Tissue redraw for the gene; Clusters and Grad-CAM just keep it for
      // when you switch to Genes.
    },
    [],
  );

  const fileName = uploaded?.name && uploaded.name !== "—" ? uploaded.name : "her2_B1.tiff";

  // Cards or table — user's choice of how the gene panel is presented.
  const [geneView, setGeneView] = useState<"cards" | "table">("table");
  // Predicted Gene Expression table/cards: ticked narrows the list to only
  // genes whose home tissue (geneHome, below) is Cancer, still ranked high
  // to low; unticked (the default) is the full unfiltered table. Only
  // meaningful (and only shown) when the prediction has tissue data at all.
  const [showOnlyCancerGenes, setShowOnlyCancerGenes] = useState(false);

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
        // The tissue line is only there when the prediction has tissue types.
        const tissue = tile.querySelector<HTMLElement>(".gene-tile-tissue");
        const tissueHeight = tissue ? tissue.offsetHeight + innerGap : 0;
        const naturalHeight =
          swatchMin + name.offsetHeight + meta.offsetHeight + tissueHeight + innerGap * 2 + padY + borderY;
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
  }, [ready, pred.topGenes.length, geneView, geneHome]);

  const filteredTopGenes = useMemo(
    () =>
      showOnlyCancerGenes && geneHome
        ? pred.topGenes.filter((g) => geneHome.get(g.name)?.cls === "Cancer")
        : pred.topGenes,
    [pred.topGenes, showOnlyCancerGenes, geneHome],
  );
  const geneTotalPages = Math.max(1, Math.ceil(filteredTopGenes.length / genesPerPage));
  const genePageClamped = Math.min(genePage, geneTotalPages - 1);
  const genePageRows = filteredTopGenes.slice(
    genePageClamped * genesPerPage,
    genePageClamped * genesPerPage + genesPerPage,
  );

  return (
    <div className={`app app-bg${showLanding ? " is-landing" : ""}`}>
      <header className="topbar">
        <div className="capsule glass cap-brand">
          <button type="button" className="home-btn" onClick={() => setLandingOpen(true)} title="Home" aria-label="Home">
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
          </button>
        </div>


        <div className="cap-middle">
        <button
          className="tutorial-launch"
          onClick={startTutorial}
          disabled={running}
          title="Start a guided tutorial of the workspace"
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <circle cx="12" cy="12" r="10" />
            <polygon points="16.24 7.76 14.12 14.12 7.76 16.24 9.88 9.88 16.24 7.76" />
          </svg>
          Take the Tutorial
        </button>
        </div>

        <div className="capsule glass cap-actions" data-tour="header-actions">
          {authEnabled && user ? (
            <>
              <button className="text-btn" data-tour="history" onClick={() => setHistoryOpen(true)}>
                History
              </button>
              <button className="pill-btn" onClick={exportPdfReport} disabled={exportingPdf}>
                {exportingPdf ? "Generating…" : "Export"}
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
                  <div className="account-menu glass-lite" role="menu">
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
            <>
              <button className="pill-btn" onClick={exportPdfReport} disabled={exportingPdf}>
                {exportingPdf ? "Generating…" : "Export"}
              </button>
              <button className="text-btn" data-tour="sign-in" onClick={() => setAuthModalOpen(true)}>
                Sign in
              </button>
            </>
          )}
        </div>
      </header>

      <main className="grid">
        {/* Column 1 — input + prediction */}
        <div className="col col-1 glass">
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
            <button className="replace-btn" title="Reset session" onClick={() => window.location.reload()}>
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
                <TissueThumb url={uploaded.url} pred={pred} alt="uploaded H&E section" />
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
                <div className="alert-text">Top predicted gene: {pred.topGenes[0]?.name ?? "unavailable"}</div>
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

          <div className="gene-card" data-tour="gene-list">
            <div className="card-title">
              Predicted Gene Expression
              <span
                className="info-icon tooltip-below tooltip-center"
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
            {ready && geneHome && (
              <label className="gene-filter-toggle" data-tour="cancer-filter">
                <input
                  type="checkbox"
                  checked={showOnlyCancerGenes}
                  onChange={(e) => {
                    setShowOnlyCancerGenes(e.target.checked);
                    setGenePage(0);
                  }}
                />
                Show Cancer-type genes
              </label>
            )}
            {!ready ? (
              <div className="empty-row">no predictions yet — upload a section</div>
            ) : (
              (() => {
                const max = maxGeneValue;
                const pick = (g: (typeof genePageRows)[number]) => {
                  // Opens the gene's description + pathway table; its "Explore
                  // gene in tissue" button then maps the gene
                  // (exploreGeneInGenesTab). The tutorial's "Map a gene" step
                  // skips the table and maps the gene straight away, as the
                  // click always used to.
                  if (tutorialStepId !== "gene-map") {
                    setPopoverAnchor(null);
                    setGenePathwayModal(g.name);
                  } else {
                    showGeneOnMap(g.name);
                  }
                };

                return geneView === "cards" ? (
                  <div className="gene-grid" ref={geneListRef}>
                    {genePageRows.map((g, index) => (
                      <button
                        key={g.name}
                        className="gene-tile"
                        data-tour={index === 0 ? "gene-first" : undefined}
                        onClick={() => pick(g)}
                      >
                        <div
                          className="gene-tile-swatch"
                          style={{ background: viridis(g.value / max) }}
                        />
                        <div className="gene-tile-name">{g.name}</div>
                        {geneHome && <GeneTissueNote gene={g.name} value={g.value} home={geneHome.get(g.name)} className="gene-tile-tissue" />}
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
                      <span aria-hidden />
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
                        onClick={() => pick(g)}
                      >
                        <span className="gene-rank">{genePageClamped * genesPerPage + index + 1}</span>
                        <span className="gene-name-cell">
                          <span className="gene-name">{g.name}</span>
                          {geneHome && <GeneTissueNote gene={g.name} value={g.value} home={geneHome.get(g.name)} className="gene-row-tissue" />}
                        </span>
                        <span className="gene-value">{g.value.toFixed(2)}</span>
                        <span className="bar-track">
                          <span
                            className="bar-fill"
                            style={{ width: `${((g.value / max) * 100).toFixed(0)}%`, background: viridis(g.value / max) }}
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

        {/* Column 2 — the stage: tissue map, full-bleed behind the floating panels */}
        <div className="col col-2 stage">
          <div className="plot-card" data-tour="plot-card">
            <div className="plot-header">
              <nav className="map-tabs" aria-label="Map view">
                <button className={view === "clusters" ? "on" : ""} disabled={!ready} onClick={() => changeView("clusters")}>
                  Clusters
                </button>
                <button className={view === "genes" ? "on" : ""} disabled={!ready} onClick={() => changeView("genes")}>
                  Genes
                </button>
                {ready && pred.tissue && (
                  <button className={view === "tissue" ? "on" : ""} onClick={() => changeView("tissue")}>
                    Tissue
                  </button>
                )}
                {gradcamOk && (
                  <button className={view === "gradcam" ? "on" : ""} disabled={!ready} onClick={() => changeView("gradcam")}>
                    Grad-CAM
                  </button>
                )}
              </nav>
              {/* Picker and third control are on every tab at fixed widths, so
                  the tabs never move when switching. */}
              <div className="gene-combo">
                <input
                  className="gsel"
                  placeholder="select a gene"
                  aria-label="gene"
                  disabled={!ready}
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
              <div className="header-slot">
                {view === "clusters" ? (
                  // Same as clicking a Cluster breakdown tile or legend pill.
                  <label className="cluster-select-wrap">
                    <select
                      className="cluster-select glass-lite"
                      aria-label="Show one cluster"
                      disabled={!ready}
                      value={clusterPin ?? ""}
                      onChange={(e) => setClusterPin(e.target.value === "" ? null : Number(e.target.value))}
                    >
                      <option value="">All clusters</option>
                      {pred.clusters.map((c, i) => (
                        <option key={i} value={i}>
                          Cluster {i}
                          {clusterLabels[i] ? ` · ${clusterLabels[i]!.short}` : ""}
                        </option>
                      ))}
                    </select>
                    <span className="gsel-caret" aria-hidden>
                      ▾
                    </span>
                  </label>
                ) : (
                  <label className={`overlay-toggle glass-lite${uploaded?.url ? "" : " is-disabled"}`}>
                    <input
                      type="checkbox"
                      checked={showImage}
                      disabled={!uploaded?.url}
                      onChange={(e) => setShowImage(e.target.checked)}
                    />
                    Show image
                  </label>
                )}
              </div>
            </div>
            {gradcamMounted && gradcamOk && (
              <GradCamPanel
                ref={gradcamRef}
                pred={pred}
                ready={ready}
                file={uploaded?.file ?? null}
                fileStatus={originalImageStatus}
                imageUrl={uploaded?.url}
                showImage={showImage}
                hidden={view !== "gradcam"}
                onStatusChange={setGradcamStatus}
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
                onTissuePin={pinTissueType}
                tissueHover={tissueHover}
                tissueGroupHover={tissueGroupHover}
                tissueClusterHover={tissueClusterHover}
                tissueClusterPin={tissueClusterPin}
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
              <TissueBreakdown pred={pred} pinned={tissuePin} onPin={pinTissueType} />
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
                        title={clusterLabels[i] ? `cluster ${i} · ${clusterLabels[i]!.full}` : undefined}
                      >
                        <div className="head">
                          <span className="dot" style={{ background: c }} />
                          <span className="name">
                            {i}
                            {clusterLabels[i] && ` · ${clusterLabels[i]!.short}`}
                          </span>
                        </div>
                        <div className="count" style={{ color: c }}>
                          {pred.counts[i]}
                        </div>
                        <div className="pct">{((pred.counts[i] / pred.total) * 100).toFixed(1)}%</div>
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
            onPin={pinTissueType}
            onHoverType={setTissueHover}
            onHoverGroup={setTissueGroupHover}
            onHoverCluster={setTissueClusterHover}
            pinnedCluster={tissueClusterPin}
            onPinCluster={pinTissueCluster}
            tab={tissueTab}
            onTabChange={setTissueTab}
          />
        )}
        <ClusterAnalysisPanel
          pred={pred}
          ready={ready}
          hidden={view === "tissue" && ready && !!pred.tissue}
          pathways={pathways}
          onRetryPathways={retryPathways}
          pathwayModal={pathwayModal}
          onPathwayModalChange={setPathwayModal}
          tourCluster={tutorialStepId === "pathways" ? tourPathwayCluster : null}
          onGeneClick={(name, rect) =>
            setPopoverAnchor({ gene: name, x: rect.left, top: rect.top, bottom: rect.bottom })
          }
        />
      </main>

      {showLanding && (
        <section className="landing" aria-label="Start a prediction">
          <div className="landing-copy">
            <div className="landing-eyebrow">Welcome to GeneX</div>
            <h1>Read the genes in a stained slide.</h1>
            <p>
              GeneX predicts spatial gene expression for HER2-positive breast cancer from an H&amp;E image. Add a
              section and explore the result.
            </p>
            <ol className="landing-steps">
              <li>
                <span className="n">1</span>
                <span>
                  <strong>Add a section</strong>
                  Drop in an H&amp;E image, or try the sample.
                </span>
              </li>
              <li>
                <span className="n">2</span>
                <span>
                  <strong>Run the prediction</strong>
                  The model estimates gene activity for every tile.
                </span>
              </li>
              <li>
                <span className="n">3</span>
                <span>
                  <strong>Explore</strong>
                  Compare clusters, genes, tissue types and Grad-CAM.
                </span>
              </li>
            </ol>
          </div>
          <UploadModal inline open onClose={() => {}} onRun={runPrediction} />
        </section>
      )}

      <UploadModal open={modalOpen} onClose={() => setModalOpen(false)} onRun={runPrediction} />
      <ProgressOverlay visible={running} stepIndex={stepIndex} />
      <AuthModal open={authModalOpen} onClose={() => setAuthModalOpen(false)} />
      <HistoryPanel
        open={historyOpen}
        onClose={() => setHistoryOpen(false)}
        onSelect={loadFromHistory}
      />
      <ProfilePanel open={profileOpen} onClose={() => setProfileOpen(false)} />
      <GenePopover
        anchor={popoverAnchor}
        onClose={() => setPopoverAnchor(null)}
        onViewPathways={(g) => {
          setPopoverAnchor(null);
          setGenePathwayModal(g);
        }}
      />
      {genePathwayModal && (
        <GenePathwayModal
          gene={genePathwayModal}
          mapLabel="Explore gene in tissue"
          onShowOnMap={
            pred.geneMeta[genePathwayModal]
              ? () => {
                  exploreGeneInGenesTab(genePathwayModal);
                  setGenePathwayModal(null);
                }
              : undefined
          }
          onClose={() => setGenePathwayModal(null)}
        />
      )}
      <div className={`toast${toast ? " show" : ""}`}>{toast}</div>
      {tutorialStepId && tutorialIndex >= 0 && (() => {
        const step = tutorialSteps[tutorialIndex];
        const chapterSteps = tutorialSteps.filter((item) => item.chapter === step.chapter);
        return (
          <TutorialOverlay
            view={{
              step: { ...step, target: tourTarget(step, tourPhase) },
              stepNumber: tutorialIndex + 1,
              stepCount: tutorialSteps.length,
              chapterStepNumber: chapterSteps.indexOf(step) + 1,
              chapterStepCount: chapterSteps.length,
            }}
            onNext={nextTutorialStep}
            onBack={previousTutorialStep}
            onSkip={endTutorial}
            onTargetActivated={nextTutorialStep}
          />
        );
      })()}
    </div>
  );
}

/** Gene list: the tissue type a gene is clearly highest in, with the numbers
 * on hover so the whole-slide value next to it is never mistaken for it. */
function GeneTissueNote({
  gene,
  value,
  home,
  className,
}: {
  gene: string;
  value: number;
  home: GeneTissue | undefined;
  className: string;
}) {
  if (!home) {
    return (
      <span className={`${className} none`} title={`${gene}: not clearly higher in any one tissue type`}>
        no clear type
      </span>
    );
  }
  const name: TissueClass = home.cls;
  return (
    <span
      className={className}
      title={`${gene}: ${home.typeMean.toFixed(2)} on average in ${name} tiles vs ${home.restMean.toFixed(2)} in all other tiles. ${value.toFixed(2)} is its average over all tiles.`}
    >
      <span className="dot" style={{ background: TISSUE_COLORS[name] }} />
      ↑ {TISSUE_SHORT_NAMES[name]}
    </span>
  );
}
