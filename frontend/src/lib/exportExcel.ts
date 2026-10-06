import * as XLSX from "xlsx";
import type { Prediction } from "@/lib/mockPrediction";
import { TISSUE_CLASSES } from "@/lib/tissue";

const round = (value: number) => Number(value.toFixed(4));

/** The export workbook. Always has the full ranked gene panel
 * (`pred.topGenes`), not just the current page. When the prediction has
 * tissue types it adds:
 *  - "Expression by tissue type": each gene's mean raw predicted expression
 *    per tissue class (the Tissue tab's bottom card, for every gene);
 *  - "Tiles": one row per tile with its grid position, cluster, tissue class,
 *    confidence and all five class probabilities. */
export function buildGeneExpressionWorkbook(pred: Prediction): XLSX.WorkBook {
  const workbook = XLSX.utils.book_new();

  const rows = pred.topGenes.map((g, i) => ({
    Rank: i + 1,
    Gene: g.name,
    "Mean expression": round(g.value),
    Level: g.level,
  }));
  const sheet = XLSX.utils.json_to_sheet(rows);
  sheet["!cols"] = [{ wch: 6 }, { wch: 14 }, { wch: 16 }, { wch: 8 }];
  XLSX.utils.book_append_sheet(workbook, sheet, "Predicted gene expression");

  if (!pred.tissue) return workbook;

  // Group tiles by class once, rather than once per gene.
  const byClass = TISSUE_CLASSES.map((cls) => pred.spots.filter((s) => s.tissue?.cls === cls));
  const byTissue = pred.topGenes.map((g) => {
    const row: Record<string, string | number | null> = { Gene: g.name };
    TISSUE_CLASSES.forEach((cls, i) => {
      const spots = byClass[i];
      row[cls] = spots.length
        ? round(spots.reduce((sum, s) => sum + (s.raw?.[g.name] ?? s.expr[g.name] ?? 0), 0) / spots.length)
        : null;
    });
    return row;
  });
  byTissue.push({ Gene: "Tiles (n)", ...Object.fromEntries(TISSUE_CLASSES.map((cls, i) => [cls, byClass[i].length])) });
  const tissueSheet = XLSX.utils.json_to_sheet(byTissue);
  tissueSheet["!cols"] = [{ wch: 14 }, ...TISSUE_CLASSES.map(() => ({ wch: 18 }))];
  XLSX.utils.book_append_sheet(workbook, tissueSheet, "Expression by tissue type");

  const tiles = pred.spots.map((s, i) => ({
    Tile: i + 1,
    "Grid X": s.gridX ?? null,
    "Grid Y": s.gridY ?? null,
    Cluster: s.cluster,
    "Tissue type": s.tissue?.cls ?? null,
    Confidence: s.tissue ? round(s.tissue.confidence) : null,
    ...Object.fromEntries(TISSUE_CLASSES.map((cls) => [`P(${cls})`, s.tissue ? round(s.tissue.probs[cls]) : null])),
  }));
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(tiles), "Tiles");

  return workbook;
}

export function exportGeneExpressionExcel(pred: Prediction, sourceName?: string) {
  const workbook = buildGeneExpressionWorkbook(pred);
  const base = sourceName ? sourceName.replace(/\.[^.]+$/, "") : "genex";
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
  XLSX.writeFile(workbook, `${base}-gene-expression-${stamp}.xlsx`);
}
