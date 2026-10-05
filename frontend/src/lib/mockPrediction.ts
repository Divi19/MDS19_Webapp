/**
 * Synthetic prediction generator.
 *
 * This is a stand-in for the real mclSTExp output. It produces the exact
 * shape the UI renders: a tissue-shaped lattice of spots, each with a
 * normalised expression vector and a K-means cluster id, plus a gene
 * ranking and per-cluster summary.
 *
 * When the Google Colab model is wired in, replace `generatePrediction()`
 * with a fetch that returns a `Prediction` (see `types.ts` shape below).
 * Nothing else in the UI needs to change.
 */

import type { PredictionTissue, SpotTissue } from "./tissue";

/* ---------- palette ---------- */
export const CL = ["#1f77b4", "#ff7f0e", "#2ca02c", "#d62728", "#9467bd"]; // tab10 0..4
export const CL_NAME = [
  "stroma-like",
  "connective",
  "carcinoma core",
  "HER2-enriched focus",
  "immune infiltrate",
];

/* genes the assistant treats as "tracked markers" */
export const NAMED_GENES = ["ERBB2", "ESR1", "MKI67", "EPCAM", "CD74", "PTPRC"];

/* declared model panel size (flavour text in the UI) */
export const PANEL_SIZE = 785;

/* ---------- types ---------- */
export interface Spot {
  x: number; // normalised 0..1 (bounding box of tissue-containing patches)
  y: number;
  /** Raw tile grid indices (ix, iy) from the model, before normalisation —
   * lets the image overlay place a spot at its true pixel position on the
   * original upload instead of stretching it across the tissue's own
   * bounding box. Absent for data with no real tiling (e.g. dummy/demo). */
  gridX?: number;
  gridY?: number;
  cluster: number;
  /** normalised 0..1 expression per gene */
  expr: Record<string, number>;
  /** Raw model-scale predicted expression per gene, as the API returned it
   * (used for per-tissue-type means). Absent on synthetic demo data. */
  raw?: Record<string, number>;
  /** Predicted tissue type — null/absent when the prediction has none. */
  tissue?: SpotTissue | null;
}

export interface GeneMeta {
  label: string;
  hx: number;
  hy: number;
  s: number;
}

export type Level = "High" | "Mid" | "Low";

export interface TopGene {
  name: string;
  value: number;
  level: Level;
}

export interface ClusterInfo {
  index: number;
  name: string;
  count: number;
  fraction: number;
}

export interface Prediction {
  spots: Spot[];
  genes: string[];
  geneMeta: Record<string, GeneMeta>;
  topGenes: TopGene[];
  clusters: ClusterInfo[];
  counts: number[];
  total: number;
  /** Tissue classifier output — null/absent when the prediction has none
   * (classifier off, failed, or a prediction saved before it existed). */
  tissue?: PredictionTissue | null;
}

/* ---------- deterministic rng ---------- */
export function mulberry32(a: number) {
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* ---------- geometry helpers (also used by the demo H&E image) ---------- */
export function gaussC(x: number, y: number, cx: number, cy: number, s: number) {
  return Math.exp(-((x - cx) ** 2 + (y - cy) ** 2) / (2 * s * s));
}
function inEllipse(x: number, y: number, cx: number, cy: number, rx: number, ry: number) {
  const dx = (x - cx) / rx;
  const dy = (y - cy) / ry;
  return dx * dx + dy * dy <= 1;
}
export function inMask(x: number, y: number) {
  return (
    inEllipse(x, y, 0.42, 0.55, 0.37, 0.42) ||
    inEllipse(x, y, 0.7, 0.66, 0.24, 0.22) ||
    inEllipse(x, y, 0.4, 0.22, 0.2, 0.17)
  );
}

/* ---------- gene panel ---------- */
const NAMED: Record<string, GeneMeta> = {
  ERBB2: { label: "ERBB2 (HER2)", hx: 0.47, hy: 0.3, s: 0.15 },
  ESR1: { label: "ESR1", hx: 0.24, hy: 0.7, s: 0.18 },
  MKI67: { label: "MKI67", hx: 0.47, hy: 0.46, s: 0.19 },
  EPCAM: { label: "EPCAM", hx: 0.5, hy: 0.5, s: 0.4 },
  CD74: { label: "CD74", hx: 0.72, hy: 0.66, s: 0.22 },
  PTPRC: { label: "PTPRC (CD45)", hx: 0.72, hy: 0.66, s: 0.24 },
};

const EXTRA = [
  "GNAS", "MYL12B", "KRT8", "KRT18", "KRT19", "TPT1", "B2M", "EEF1A1", "ACTB",
  "RPS27", "MT-CO1", "FTL", "GATA3", "FOXA1", "CDH1", "VIM", "PGR", "TOP2A",
  "CCND1", "MYC", "EGFR", "KRT5", "MUC1", "CEACAM6", "S100A8", "S100A9", "CD68",
  "CD3D", "CD8A", "COL1A1", "COL1A2", "FN1", "SPARC", "TIMP1", "IGKC", "IGHG1",
  "HLA-A", "HLA-DRA", "TFF1", "TFF3", "XBP1", "KRT7", "AGR2", "NDRG1", "MGP",
  "APOD", "CXCL9",
];

/* fixed ranking shown in the col-1 table (model ranking) */
const TOP: TopGene[] = [
  { name: "ERBB2", value: 4.82, level: "High" },
  { name: "GNAS", value: 4.31, level: "High" },
  { name: "MYL12B", value: 4.04, level: "High" },
  { name: "KRT8", value: 3.78, level: "High" },
  { name: "TPT1", value: 3.52, level: "Mid" },
  { name: "B2M", value: 3.21, level: "Mid" },
  { name: "EEF1A1", value: 2.95, level: "Mid" },
  { name: "KRT18", value: 2.71, level: "Mid" },
  { name: "ACTB", value: 2.34, level: "Mid" },
  { name: "RPS27", value: 1.92, level: "Low" },
  { name: "MT-CO1", value: 1.58, level: "Low" },
  { name: "FTL", value: 1.21, level: "Low" },
];

/* ---------- generator ---------- */
export function generatePrediction(): Prediction {
  const rand = mulberry32(11);

  const geneMeta: Record<string, GeneMeta> = { ...NAMED };
  for (const g of EXTRA) {
    geneMeta[g] = {
      label: g,
      hx: 0.2 + rand() * 0.6,
      hy: 0.2 + rand() * 0.6,
      s: 0.14 + rand() * 0.16,
    };
  }
  const genes = Object.keys(geneMeta);

  const clamp = (v: number) => (v < 0 ? 0 : v);
  function assignCluster(x: number, y: number) {
    const w = [
      0.15 + 3.2 * clamp(0.42 - x) * clamp(y - 0.42),
      0.15 + 2.6 * clamp(x - 0.58),
      0.55 + 0.7 * gaussC(x, y, 0.5, 0.5, 0.24),
      0.3 + 1.9 * gaussC(x, y, 0.47, 0.34, 0.18),
      0.2 + 2.2 * gaussC(x, y, 0.72, 0.66, 0.16),
    ];
    const sum = w.reduce((a, b) => a + b, 0);
    let r = rand() * sum;
    for (let k = 0; k < 5; k++) {
      r -= w[k];
      if (r <= 0) return k;
    }
    return 4;
  }

  const COLS = 32;
  const ROWS = 26;
  const spots: Spot[] = [];
  for (let i = 0; i < COLS; i++) {
    for (let j = 0; j < ROWS; j++) {
      const x = (i + 0.5) / COLS + (rand() - 0.5) * 0.01;
      const y = (j + 0.5) / ROWS + (rand() - 0.5) * 0.01;
      if (inMask(x, y)) spots.push({ x, y, cluster: 0, expr: {} });
    }
  }
  for (const s of spots) s.cluster = assignCluster(s.x, s.y);

  const field = (x: number, y: number, g: GeneMeta) =>
    gaussC(x, y, g.hx, g.hy, g.s) + (rand() - 0.5) * 0.1;

  for (const k of genes) {
    const g = geneMeta[k];
    let mn = 1e9;
    let mx = -1e9;
    const a: number[] = [];
    for (const s of spots) {
      const v = field(s.x, s.y, g);
      a.push(v);
      if (v < mn) mn = v;
      if (v > mx) mx = v;
    }
    for (let i = 0; i < spots.length; i++) {
      spots[i].expr[k] = (a[i] - mn) / (mx - mn || 1);
    }
  }

  const counts = [0, 0, 0, 0, 0];
  for (const s of spots) counts[s.cluster]++;
  const total = spots.length;

  const clusters: ClusterInfo[] = CL.map((_, index) => ({
    index,
    name: CL_NAME[index],
    count: counts[index],
    fraction: total ? counts[index] / total : 0,
  }));

  return { spots, genes, geneMeta, topGenes: TOP, clusters, counts, total };
}

/* ---------- viridis ---------- */
const VIR = [
  [68, 1, 84],
  [59, 82, 139],
  [33, 145, 140],
  [94, 201, 98],
  [253, 231, 37],
];
export function viridis(t: number) {
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const f = t * 4;
  const i = Math.floor(f);
  const u = f - i;
  const a = VIR[i];
  const b = VIR[Math.min(4, i + 1)];
  return `rgb(${Math.round(a[0] + (b[0] - a[0]) * u)},${Math.round(
    a[1] + (b[1] - a[1]) * u,
  )},${Math.round(a[2] + (b[2] - a[2]) * u)})`;
}

/* ---------- stats helpers ---------- */
export function geneStats(pred: Prediction, k: string) {
  const sum = [0, 0, 0, 0, 0];
  const n = [0, 0, 0, 0, 0];
  for (const s of pred.spots) {
    sum[s.cluster] += s.expr[k] ?? 0;
    n[s.cluster]++;
  }
  let dom = 0;
  let best = -1;
  for (let c = 0; c < 5; c++) {
    const m = n[c] ? sum[c] / n[c] : 0;
    if (m > best) {
      best = m;
      dom = c;
    }
  }
  return { dom, avg: best };
}

export function centroid(pred: Prediction, c: number) {
  let sx = 0;
  let sy = 0;
  let n = 0;
  for (const s of pred.spots) {
    if (s.cluster === c) {
      sx += s.x;
      sy += s.y;
      n++;
    }
  }
  return n ? { x: sx / n, y: sy / n } : { x: 0.5, y: 0.5 };
}

export function locationOf(x: number, y: number) {
  const h = x < 0.38 ? "left" : x > 0.62 ? "right" : "central";
  const v = y < 0.38 ? "upper" : y > 0.62 ? "lower" : "mid";
  if (h === "central" && v === "mid") return "the centre";
  if (h === "central") return `the ${v} area`;
  if (v === "mid") return `the ${h} side`;
  return `the ${v}-${h}`;
}
