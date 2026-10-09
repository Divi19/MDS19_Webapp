import { Document, Page, View, Text, Svg, Circle, Ellipse, Image as PdfImage, StyleSheet, pdf } from "@react-pdf/renderer";
import { CL } from "@/lib/mockPrediction";
import type { Prediction } from "@/lib/mockPrediction";
import type { ClusterAnalysis } from "@/lib/clusterAnalysis";
import type { PathwayState } from "@/lib/pathways";
import { TISSUE_CLASSES, TISSUE_COLORS, comparableTypes, genesHigherIn, clusterTissueTable } from "@/lib/tissue";

export interface ReportData {
  sampleName: string;
  generatedAt: Date;
  pred: Prediction;
  analysis: ClusterAnalysis[];
  pathways: Record<number, PathwayState>;
  /** PNG data URL of the Grad-CAM mosaic, captured from the live canvas.
   * Required — the export is gated on this already being available (see
   * GeneXApp's export handler), so this is never undefined in practice. */
  gradcamImage: string;
}

/** Strips each category's own ID prefix, same as the live Cluster Analysis
 * panel — KEGG uses a bare colon ("hsa05224:Breast cancer"), Reactome and
 * GO use a tilde ("R-HSA-1306955~GRB7 events in ERBB2 signaling"). */
function formatTerm(term: string): string {
  const afterTilde = term.split("~");
  if (afterTilde.length > 1) return afterTilde.slice(1).join("~");
  return term.replace(/^[a-zA-Z]+\d+:/, "");
}

const INK = "#1a1f2b";
const MUTED = "#5c5a52";
const MUTED2 = "#8d897c";
const BORDER = "#d9d2c4";
const ACCENT = "#0c7a8a";
const ACCENT_DARK = "#0a6675";
const ACCENT_SOFT = "#0c7a8a14";
const SURFACE2 = "#f6f3ed";

const styles = StyleSheet.create({
  page: { padding: "40 44", fontSize: 9.5, fontFamily: "Helvetica", color: INK },
  pageHead: {
    flexDirection: "row",
    justifyContent: "space-between",
    fontSize: 7.5,
    color: MUTED2,
    borderBottom: `1 solid ${BORDER}`,
    paddingBottom: 8,
    marginBottom: 18,
    textTransform: "uppercase",
    letterSpacing: 0.5,
  },
  eyebrow: {
    fontSize: 8.5,
    fontWeight: 700,
    color: ACCENT,
    marginBottom: 6,
    textTransform: "uppercase",
    letterSpacing: 0.6,
  },
  h1: { fontSize: 20, fontFamily: "Times-Bold", marginBottom: 12 },
  h2: { fontSize: 12, fontFamily: "Times-Bold", marginTop: 16, marginBottom: 7 },
  body: { fontSize: 9.5, lineHeight: 1.5, color: INK, marginBottom: 8, maxWidth: 440 },
  statRow: { flexDirection: "row", gap: 8, marginBottom: 16 },
  statTile: { flex: 1, backgroundColor: ACCENT_SOFT, border: `1 solid ${BORDER}`, borderRadius: 6, padding: 8 },
  statLabel: { fontSize: 6.5, color: MUTED, textTransform: "uppercase" },
  statValue: { fontSize: 14, fontFamily: "Times-Bold", color: ACCENT_DARK, marginTop: 2 },
  statSub: { fontSize: 6.5, color: MUTED2, marginTop: 1 },
  table: { marginTop: 4, marginBottom: 12 },
  tr: { flexDirection: "row", borderBottom: `1 solid ${BORDER}` },
  thRow: { flexDirection: "row", borderBottom: `1.5 solid ${INK}` },
  th: { fontSize: 7, textTransform: "uppercase", color: MUTED2, padding: 4, flex: 1 },
  td: { fontSize: 8.5, padding: 4, flex: 1 },
  tdMono: { fontSize: 8.5, padding: 4, flex: 1, fontFamily: "Courier-Bold" },
  tdRight: { textAlign: "right" },
  swatch: { width: 6, height: 6, borderRadius: 3, marginRight: 4 },
  cardRow: { flexDirection: "row" },
  findings: { marginTop: 4 },
  findingItem: { flexDirection: "row", gap: 6, paddingVertical: 6, borderBottom: `1 solid ${BORDER}`, fontSize: 9 },
  findingDot: { width: 4, height: 4, borderRadius: 2, backgroundColor: ACCENT, marginTop: 3 },
  clusterCard: {
    border: `1 solid ${BORDER}`,
    borderRadius: 6,
    padding: 9,
    marginBottom: 7,
    backgroundColor: "#fdfcf9",
  },
  clusterCardHead: { flexDirection: "row", alignItems: "center", gap: 5, marginBottom: 4 },
  clusterCardName: { fontFamily: "Times-Bold", fontSize: 10 },
  clusterCardCount: { fontSize: 7.5, color: MUTED, marginLeft: "auto" },
  chipRow: { flexDirection: "row", flexWrap: "wrap", gap: 3, marginBottom: 4 },
  chip: { fontSize: 7.5, fontFamily: "Courier-Bold", color: ACCENT_DARK, backgroundColor: ACCENT_SOFT, borderRadius: 3, paddingVertical: 2, paddingHorizontal: 5 },
  cardText: { fontSize: 7.8, color: MUTED, lineHeight: 1.4 },
  pill: { fontSize: 7.5, fontFamily: "Courier-Bold", borderRadius: 3, paddingVertical: 2, paddingHorizontal: 5, marginRight: 4, marginBottom: 3 },
  legendRow: { flexDirection: "row", flexWrap: "wrap", gap: 10, marginTop: 8, marginBottom: 4 },
  legendItem: { flexDirection: "row", alignItems: "center", gap: 4, fontSize: 7.5, color: MUTED },
  mapBox: { border: `1 solid ${BORDER}`, borderRadius: 6, backgroundColor: SURFACE2 },
  stackBar: { flexDirection: "row", height: 14, borderRadius: 4, overflow: "hidden", border: `1 solid ${BORDER}`, marginTop: 6, marginBottom: 8 },
  pageFoot: {
    position: "absolute",
    bottom: 24,
    left: 44,
    right: 44,
    flexDirection: "row",
    justifyContent: "space-between",
    fontSize: 7,
    color: MUTED2,
    borderTop: `1 solid ${BORDER}`,
    paddingTop: 6,
  },
  // cover
  coverTop: { flexDirection: "row", alignItems: "center", gap: 8 },
  coverLogo: { width: 20, height: 20, borderRadius: 5, backgroundColor: ACCENT },
  coverWordmark: { fontFamily: "Courier-Bold", fontSize: 10, letterSpacing: 0.5 },
  coverKicker: { fontSize: 8, color: ACCENT, textTransform: "uppercase", letterSpacing: 0.8, marginTop: 100, marginBottom: 10 },
  coverTitle: { fontSize: 28, fontFamily: "Times-Bold", lineHeight: 1.2, maxWidth: 380 },
  coverSample: { fontFamily: "Courier", fontSize: 10, color: MUTED, marginTop: 12 },
  coverMeta: {
    position: "absolute",
    bottom: 60,
    left: 44,
    right: 44,
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 16,
    borderTop: `1 solid ${BORDER}`,
    paddingTop: 14,
  },
  coverMetaItem: { width: "44%" },
  coverMetaLabel: { fontSize: 6.5, color: MUTED2, textTransform: "uppercase" },
  coverMetaValue: { fontFamily: "Courier-Bold", fontSize: 9, color: INK, marginTop: 2 },
  // TOC
  tocRow: { flexDirection: "row", alignItems: "baseline", gap: 6, paddingVertical: 7, borderBottom: `1 solid ${BORDER}` },
  tocNum: { fontFamily: "Courier", fontSize: 8, color: ACCENT, width: 14 },
  tocName: { fontFamily: "Times-Bold", fontSize: 10 },
});

function PageHead({ page }: { page: string }) {
  return (
    <View style={styles.pageHead} fixed>
      <Text>GeneX · Spatial Expression Report</Text>
      <Text render={() => page} />
    </View>
  );
}

function Swatch({ color }: { color: string }) {
  return <View style={[styles.swatch, { backgroundColor: color }]} />;
}

/** Real per-spot cluster map — every spot at its true normalised (x, y)
 * position, coloured by its real cluster. `highlight` restricts full colour
 * to one cluster and fades every other spot, matching the live app's
 * click-to-pin highlight; omitted, every cluster shows at full colour. */
function ClusterMapSvg({
  pred,
  width,
  height,
  highlight,
}: {
  pred: Prediction;
  width: number;
  height: number;
  highlight?: number;
}) {
  const pad = 4;
  return (
    <Svg width={width} height={height} viewBox={`0 0 ${width} ${height}`}>
      <Ellipse
        cx={width / 2}
        cy={height / 2}
        rx={width / 2 - 1}
        ry={height / 2 - 1}
        fill={SURFACE2}
        stroke={BORDER}
      />
      {pred.spots.map((s, i) => {
        const on = highlight === undefined || s.cluster === highlight;
        const cx = pad + s.x * (width - 2 * pad);
        const cy = pad + s.y * (height - 2 * pad);
        return (
          <Circle
            key={i}
            cx={cx}
            cy={cy}
            r={on ? (highlight === undefined ? 1.5 : 1.9) : 1.3}
            fill={on ? CL[s.cluster] : "#9a978d"}
            fillOpacity={on ? 1 : 0.22}
          />
        );
      })}
    </Svg>
  );
}

function Cover({ data }: { data: ReportData }) {
  const { pred, sampleName, generatedAt } = data;
  const topGene = pred.topGenes[0]?.name ?? "—";
  return (
    <Page size="A4" style={styles.page}>
      <View style={styles.coverTop}>
        <View style={styles.coverLogo} />
        <Text style={styles.coverWordmark}>GENEX</Text>
      </View>
      <Text style={styles.coverKicker}>Spatial Gene Expression · Analysis Report</Text>
      <Text style={styles.coverTitle}>Spatial Gene Expression Analysis Report</Text>
      <Text style={styles.coverSample}>Sample {sampleName}</Text>

      <View style={styles.coverMeta}>
        <View style={styles.coverMetaItem}>
          <Text style={styles.coverMetaLabel}>Generated</Text>
          <Text style={styles.coverMetaValue}>{generatedAt.toLocaleString()}</Text>
        </View>
        <View style={styles.coverMetaItem}>
          <Text style={styles.coverMetaLabel}>Top gene</Text>
          <Text style={styles.coverMetaValue}>{topGene}</Text>
        </View>
        <View style={styles.coverMetaItem}>
          <Text style={styles.coverMetaLabel}>Spots analysed</Text>
          <Text style={styles.coverMetaValue}>{pred.total}</Text>
        </View>
        <View style={styles.coverMetaItem}>
          <Text style={styles.coverMetaLabel}>Expression clusters</Text>
          <Text style={styles.coverMetaValue}>{pred.clusters.length}</Text>
        </View>
        <View style={styles.coverMetaItem}>
          <Text style={styles.coverMetaLabel}>Pathway source</Text>
          <Text style={styles.coverMetaValue}>DAVID (KEGG, Reactome, GO:BP)</Text>
        </View>
        <View style={styles.coverMetaItem}>
          <Text style={styles.coverMetaLabel}>Prepared with</Text>
          <Text style={styles.coverMetaValue}>GeneX</Text>
        </View>
      </View>
    </Page>
  );
}

function Toc({ data }: { data: ReportData }) {
  const hasTissue = !!data.pred.tissue;
  const rows = [
    { n: "01", name: "Executive Summary" },
    { n: "02", name: "Sample Overview" },
    { n: "03", name: "Cluster Analysis" },
    { n: "04", name: "Pathway Enrichment" },
    { n: "05", name: "Gene Expression Summary" },
    ...(hasTissue
      ? [
          { n: "06", name: "Tissue Composition Analysis" },
          { n: "07", name: "Tissue-Specific Gene Expression" },
        ]
      : []),
    { n: hasTissue ? "08" : "06", name: "Explainability (Grad-CAM)" },
  ];
  return (
    <Page size="A4" style={styles.page}>
      <PageHead page="Contents" />
      <Text style={styles.h1}>Contents</Text>
      <View>
        {rows.map((r) => (
          <View key={r.n} style={styles.tocRow}>
            <Text style={styles.tocNum}>{r.n}</Text>
            <Text style={styles.tocName}>{r.name}</Text>
          </View>
        ))}
      </View>
      <Text style={[styles.body, { marginTop: 16, color: MUTED2, fontSize: 8 }]}>
        This report is generated automatically from one GeneX prediction run. Figures and pathway results reflect
        the model&apos;s predictions, not direct laboratory measurements.
      </Text>
    </Page>
  );
}

function ExecutiveSummary({ data }: { data: ReportData }) {
  const { pred, analysis } = data;
  const topGene = pred.topGenes[0];
  const significantClusters = analysis.filter((a) => {
    const p = data.pathways[a.index];
    return p?.status === "done" && p.results.length > 0;
  });
  const dominantTissue = pred.tissue
    ? TISSUE_CLASSES.reduce((best, cls) =>
        pred.tissue!.summary[cls].fraction > pred.tissue!.summary[best].fraction ? cls : best,
      TISSUE_CLASSES[0])
    : null;

  return (
    <Page size="A4" style={styles.page}>
      <PageHead page="03" />
      <Text style={styles.eyebrow}>Section 01</Text>
      <Text style={styles.h1}>Executive Summary</Text>
      <Text style={styles.body}>
        This report summarises the spatial gene expression prediction for sample{" "}
        <Text style={{ fontFamily: "Courier-Bold" }}>{data.sampleName}</Text>. GeneX predicted expression across{" "}
        {pred.genes.length} genes for each of {pred.total} tissue spots, grouped into {pred.clusters.length}{" "}
        expression clusters. Pathway enrichment against DAVID (KEGG, Reactome, and GO Biological Process) returned
        significant matches for {significantClusters.length} of {analysis.length} clusters.
      </Text>

      <View style={styles.statRow}>
        <View style={styles.statTile}>
          <Text style={styles.statLabel}>Total spots</Text>
          <Text style={styles.statValue}>{pred.total}</Text>
        </View>
        <View style={styles.statTile}>
          <Text style={styles.statLabel}>Clusters</Text>
          <Text style={styles.statValue}>{pred.clusters.length}</Text>
        </View>
        <View style={styles.statTile}>
          <Text style={styles.statLabel}>Top gene</Text>
          <Text style={styles.statValue}>{topGene?.name ?? "—"}</Text>
        </View>
        {dominantTissue && (
          <View style={styles.statTile}>
            <Text style={styles.statLabel}>Dominant tissue</Text>
            <Text style={styles.statValue}>{dominantTissue}</Text>
            <Text style={styles.statSub}>{(pred.tissue!.summary[dominantTissue].fraction * 100).toFixed(0)}% of spots</Text>
          </View>
        )}
      </View>

      <Text style={styles.h2}>Key observations</Text>
      <View style={styles.findings}>
        {analysis.map((a) => {
          const p = data.pathways[a.index];
          const topMarker = a.markers[0];
          if (!topMarker) return null;
          const pathwayNote =
            p?.status === "done"
              ? p.results.length
                ? `matched ${p.results.slice(0, 2).map((r) => formatTerm(r.term)).join(", ")}`
                : "no significant pathway matched"
              : "pathway lookup not yet complete";
          return (
            <View key={a.index} style={styles.findingItem}>
              <View style={styles.findingDot} />
              <Text style={{ flex: 1 }}>
                <Text style={{ fontFamily: "Courier-Bold" }}>Cluster {a.index}</Text> ({a.count} spots,{" "}
                {(a.fraction * 100).toFixed(1)}%) is led by {topMarker.name} ({topMarker.diff >= 0 ? "+" : ""}
                {topMarker.diff.toFixed(2)}); {pathwayNote}.
              </Text>
            </View>
          );
        })}
      </View>
    </Page>
  );
}

function SampleOverview({ data }: { data: ReportData }) {
  const { pred } = data;
  const rows: [string, string][] = [
    ["Sample file", data.sampleName],
    ["Generated", data.generatedAt.toLocaleString()],
    ["Spots analysed", String(pred.total)],
    ["Genes predicted per spot", String(pred.genes.length)],
    ["Expression clusters identified", String(pred.clusters.length)],
    ["Pathway database", "DAVID (KEGG_PATHWAY, REACTOME_PATHWAY, GOTERM_BP_FAT)"],
  ];
  return (
    <Page size="A4" style={styles.page}>
      <PageHead page="04" />
      <Text style={styles.eyebrow}>Section 02</Text>
      <Text style={styles.h1}>Sample Overview</Text>
      <View style={styles.table}>
        {rows.map(([k, v]) => (
          <View key={k} style={styles.tr}>
            <Text style={[styles.tdMono, { flex: 1.2 }]}>{k}</Text>
            <Text style={[styles.td, { flex: 2 }]}>{v}</Text>
          </View>
        ))}
      </View>
      <Text style={styles.body}>
        All values in this report are GeneX&apos;s predictions for this sample, not directly measured laboratory
        results.
      </Text>
    </Page>
  );
}

function ClusterAnalysisPages({ data }: { data: ReportData }) {
  const { pred, analysis } = data;
  return (
    <>
      <Page size="A4" style={styles.page}>
        <PageHead page="05" />
        <Text style={styles.eyebrow}>Section 03</Text>
        <Text style={styles.h1}>Cluster Analysis</Text>
        <Text style={styles.body}>
          The full tissue section, coloured by expression cluster — every spot at its real predicted position.
          Clusters are ranked below by their top differential gene: the gene with the largest difference between
          its mean expression inside the cluster and its mean across the rest of the tissue.
        </Text>

        <View style={[styles.mapBox, { width: "100%", height: 260 }]}>
          <ClusterMapSvg pred={pred} width={460} height={260} />
        </View>
        <View style={styles.legendRow}>
          {analysis.map((a) => (
            <View key={a.index} style={styles.legendItem}>
              <Swatch color={CL[a.index]} />
              <Text>
                Cluster {a.index} · {a.count} spots
              </Text>
            </View>
          ))}
        </View>

        <View style={styles.table}>
          <View style={styles.thRow}>
            <Text style={styles.th}>Cluster</Text>
            <Text style={styles.th}>Spots</Text>
            <Text style={styles.th}>% of tissue</Text>
            <Text style={[styles.th, { flex: 1.6 }]}>Top gene</Text>
          </View>
          {analysis.map((a) => {
            const top = a.markers[0];
            return (
              <View key={a.index} style={styles.tr}>
                <View style={[styles.td, { flexDirection: "row", alignItems: "center" }]}>
                  <Swatch color={CL[a.index]} />
                  <Text>Cluster {a.index}</Text>
                </View>
                <Text style={styles.td}>{a.count}</Text>
                <Text style={styles.td}>{(a.fraction * 100).toFixed(1)}%</Text>
                <Text style={[styles.tdMono, { flex: 1.6 }]}>
                  {top ? `${top.name} ${top.diff >= 0 ? "↑" : "↓"} ${Math.abs(top.diff).toFixed(2)}` : "—"}
                </Text>
              </View>
            );
          })}
        </View>
      </Page>

      <Page size="A4" style={styles.page}>
        <PageHead page="06" />
        <Text style={styles.eyebrow}>Section 03 · continued</Text>
        <Text style={styles.h1}>Cluster Analysis</Text>
        {analysis.map((a) => (
          <View key={a.index} style={styles.clusterCard} wrap={false}>
            <View style={styles.clusterCardHead}>
              <Swatch color={CL[a.index]} />
              <Text style={styles.clusterCardName}>Cluster {a.index}</Text>
              <Text style={styles.clusterCardCount}>
                {a.count} spots · {(a.fraction * 100).toFixed(1)}%
              </Text>
            </View>
            <View style={styles.chipRow}>
              {a.markers.map((m) => (
                <Text key={m.name} style={styles.chip}>
                  {m.name}
                </Text>
              ))}
            </View>
            <Text style={styles.cardText}>{a.summary}</Text>
          </View>
        ))}
      </Page>
    </>
  );
}

function PathwayEnrichment({ data }: { data: ReportData }) {
  const { analysis, pathways } = data;
  return (
    <Page size="A4" style={styles.page}>
      <PageHead page="07" />
      <Text style={styles.eyebrow}>Section 04</Text>
      <Text style={styles.h1}>Pathway Enrichment</Text>
      <Text style={styles.body}>
        Each cluster&apos;s top genes are tested against DAVID&apos;s KEGG, Reactome, and GO Biological Process
        databases together. Because a cluster&apos;s gene list is short relative to the hundreds of pathway terms
        tested, results are screened on the Benjamini-Hochberg FDR-corrected p-value, not the raw p-value. A cluster
        with no listed pathway below does not have genes of no known function — it simply found no match that
        survived correction.
      </Text>

      {analysis.map((a) => {
        const p = pathways[a.index];
        return (
          <View key={a.index} wrap={false} style={{ marginBottom: 10 }}>
            <Text style={styles.h2}>Cluster {a.index}</Text>
            {p?.status === "done" ? (
              p.results.length ? (
                <View style={{ flexDirection: "row", flexWrap: "wrap" }}>
                  {p.results.map((r) => (
                    <Text
                      key={r.term}
                      style={[styles.pill, { color: CL[a.index], backgroundColor: `${CL[a.index]}22` }]}
                    >
                      {formatTerm(r.term)}
                    </Text>
                  ))}
                </View>
              ) : (
                <Text style={[styles.cardText]}>No significant pathways found.</Text>
              )
            ) : p?.status === "error" ? (
              <Text style={styles.cardText}>{p.message}</Text>
            ) : (
              <Text style={styles.cardText}>Pathway lookup was not complete when this report was generated.</Text>
            )}
          </View>
        );
      })}
    </Page>
  );
}

function GeneExpressionSummary({ data }: { data: ReportData }) {
  const { pred } = data;
  return (
    <Page size="A4" style={styles.page} wrap>
      <PageHead page="08" />
      <Text style={styles.eyebrow}>Section 05</Text>
      <Text style={styles.h1}>Gene Expression Summary</Text>
      <Text style={styles.body}>
        The complete predicted gene panel for this sample, ranked by mean predicted expression across all{" "}
        {pred.total} spots.
      </Text>
      <View style={styles.thRow} fixed>
        <Text style={[styles.th, { flex: 0.6 }]}>Rank</Text>
        <Text style={styles.th}>Gene</Text>
        <Text style={styles.th}>Mean expression</Text>
        <Text style={styles.th}>Level</Text>
      </View>
      {pred.topGenes.map((g, i) => (
        <View key={g.name} style={styles.tr} wrap={false}>
          <Text style={[styles.td, { flex: 0.6 }]}>{i + 1}</Text>
          <Text style={styles.tdMono}>{g.name}</Text>
          <Text style={styles.td}>{g.value.toFixed(2)}</Text>
          <Text style={styles.td}>{g.level}</Text>
        </View>
      ))}
    </Page>
  );
}

function TissueComposition({ data }: { data: ReportData }) {
  const { pred } = data;
  if (!pred.tissue) return null;
  const table = clusterTissueTable(pred);
  return (
    <Page size="A4" style={styles.page}>
      <PageHead page="09" />
      <Text style={styles.eyebrow}>Section 06</Text>
      <Text style={styles.h1}>Tissue Composition Analysis</Text>
      <Text style={styles.body}>
        Tissue-type share is predicted by GeneX&apos;s tissue classifier, which merges invasive and in-situ cancer
        into one class. Spots below 50% top-class confidence are excluded from these figures.
      </Text>

      <Text style={styles.h2}>Overall composition</Text>
      <View style={styles.stackBar}>
        {TISSUE_CLASSES.map((cls) => (
          <View
            key={cls}
            style={{ width: `${pred.tissue!.summary[cls].fraction * 100}%`, backgroundColor: TISSUE_COLORS[cls] }}
          />
        ))}
      </View>
      <View style={styles.legendRow}>
        {TISSUE_CLASSES.map((cls) => (
          <View key={cls} style={styles.legendItem}>
            <Swatch color={TISSUE_COLORS[cls]} />
            <Text>
              {cls} · {(pred.tissue!.summary[cls].fraction * 100).toFixed(0)}%
            </Text>
          </View>
        ))}
      </View>

      <Text style={styles.h2}>Composition by expression cluster</Text>
      {pred.clusters.map((c, i) => {
        const rowCounts = table[i] ?? [];
        const rowTotal = rowCounts.reduce((a, b) => a + b, 0) || 1;
        return (
          <View key={i} style={{ flexDirection: "row", alignItems: "center", gap: 8, marginBottom: 7 }} wrap={false}>
            <View style={{ width: 46, height: 34 }}>
              <ClusterMapSvg pred={pred} width={46} height={34} highlight={i} />
            </View>
            <Text style={{ width: 54, fontSize: 7.5, fontFamily: "Courier" }}>Cluster {i}</Text>
            <View style={{ flex: 1, flexDirection: "row", height: 10, borderRadius: 3, overflow: "hidden" }}>
              {TISSUE_CLASSES.map((cls, ci) => (
                <View
                  key={cls}
                  style={{ width: `${(rowCounts[ci] / rowTotal) * 100}%`, backgroundColor: TISSUE_COLORS[cls] }}
                />
              ))}
            </View>
          </View>
        );
      })}
    </Page>
  );
}

function TissueSpecificGenes({ data }: { data: ReportData }) {
  const { pred } = data;
  if (!pred.tissue) return null;
  const comparable = comparableTypes(pred);
  return (
    <Page size="A4" style={styles.page}>
      <PageHead page="10" />
      <Text style={styles.eyebrow}>Section 07</Text>
      <Text style={styles.h1}>Tissue-Specific Gene Expression</Text>
      <Text style={styles.body}>
        Genes whose mean expression within a tissue type exceeds the pooled tile-to-tile standard deviation above
        the tissue-wide mean. Types with too few confident tiles to compare are shown without a gene list.
      </Text>
      <View style={styles.table}>
        <View style={styles.thRow}>
          <Text style={styles.th}>Tissue type</Text>
          <Text style={styles.th}>Tiles</Text>
          <Text style={[styles.th, { flex: 2.5 }]}>Genes elevated in this type</Text>
        </View>
        {TISSUE_CLASSES.map((cls) => {
          const count = pred.tissue!.summary[cls].count;
          const higher = comparable.includes(cls) ? genesHigherIn(pred, cls, 8) : [];
          return (
            <View key={cls} style={styles.tr}>
              <View style={[styles.td, { flexDirection: "row", alignItems: "center" }]}>
                <Swatch color={TISSUE_COLORS[cls]} />
                <Text>{cls}</Text>
              </View>
              <Text style={styles.td}>{count}</Text>
              {comparable.includes(cls) ? (
                <Text style={[styles.tdMono, { flex: 2.5 }]}>
                  {higher.length ? higher.map((h) => h.gene).join(", ") : "none clearly elevated"}
                </Text>
              ) : (
                <Text style={[styles.td, { flex: 2.5, color: MUTED2 }]}>insufficient tiles for a reliable estimate</Text>
              )}
            </View>
          );
        })}
      </View>
    </Page>
  );
}

function Explainability({ data, pageNum }: { data: ReportData; pageNum: string }) {
  const sectionNum = data.pred.tissue ? "08" : "06";
  const topGene = data.pred.topGenes[0]?.name ?? "the top predicted gene";
  return (
    <Page size="A4" style={styles.page}>
      <PageHead page={pageNum} />
      <Text style={styles.eyebrow}>Section {sectionNum}</Text>
      <Text style={styles.h1}>Explainability (Grad-CAM)</Text>
      <Text style={styles.body}>
        Grad-CAM highlights which regions of the uploaded section most influenced the model&apos;s prediction for{" "}
        {topGene}, the slide&apos;s top predicted gene. Warmer colour indicates higher attention; it reflects what
        the model weighted most heavily, not a measured biological signal.
      </Text>
      <PdfImage src={data.gradcamImage} style={{ width: "100%", borderRadius: 6, border: `1 solid ${BORDER}` }} />
      <Text style={[styles.cardText, { marginTop: 8 }]}>
        Grad-CAM attention map for {topGene} across the full section, captured from the live Spatial Map.
      </Text>
      <View style={styles.pageFoot} fixed>
        <Text>GeneX · MDS19, Monash University</Text>
        <Text>End of report</Text>
      </View>
    </Page>
  );
}

function ReportDocument({ data }: { data: ReportData }) {
  const hasTissue = !!data.pred.tissue;
  return (
    <Document title={`GeneX Report — ${data.sampleName}`}>
      <Cover data={data} />
      <Toc data={data} />
      <ExecutiveSummary data={data} />
      <SampleOverview data={data} />
      <ClusterAnalysisPages data={data} />
      <PathwayEnrichment data={data} />
      <GeneExpressionSummary data={data} />
      {hasTissue && <TissueComposition data={data} />}
      {hasTissue && <TissueSpecificGenes data={data} />}
      <Explainability data={data} pageNum={hasTissue ? "11" : "09"} />
    </Document>
  );
}

/** Builds the full PDF and returns it as a Blob, ready to save or download. */
export async function generateReportPdf(data: ReportData): Promise<Blob> {
  return pdf(<ReportDocument data={data} />).toBlob();
}

export function reportFileName(sampleName: string): string {
  const base = sampleName.replace(/\.[^.]+$/, "") || "genex";
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
  return `${base}-report-${stamp}.pdf`;
}
