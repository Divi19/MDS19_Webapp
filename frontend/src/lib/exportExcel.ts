import * as XLSX from "xlsx";
import type { Prediction } from "@/lib/mockPrediction";
import { comparableTypes, genesHigherIn, MIN_TILES, TISSUE_CLASSES } from "@/lib/tissue";

const round = (value: number) => Number(value.toFixed(4));

/** The export workbook. Always has the full ranked gene panel
 * (`pred.topGenes`), not just the current page. When the prediction has
 * tissue types it adds:
 *  - "Expression by tissue type": each gene's mean raw predicted expression
 *    per tissue class (the Tissue tab's bottom card, for every gene);
 *  - "Tiles": one row per tile with its grid position, cluster, tissue class,
 *    confidence and all five class probabilities;
 *  - "Genes higher by tissue type": the Tissue Analysis panel's lists for
 *    every type with enough tiles (same rules: at least MIN_TILES tiles, and
 *    a difference at least the tile-to-tile spread). */
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

  const higher = comparableTypes(pred).flatMap((cls): Record<string, string | number | null>[] => {
    const genes = genesHigherIn(pred, cls, 10);
    if (!genes.length) return [{ "Tissue type": cls, Rank: null, Gene: "(none clearly higher)" }];
    return genes.map((g, i) => ({
      "Tissue type": cls,
      Rank: i + 1,
      Gene: g.gene,
      "Mean in type": round(g.typeMean),
      "Mean in other tiles": round(g.restMean),
      Difference: round(g.diff),
    }));
  });
  const higherSheet = higher.length
    ? XLSX.utils.json_to_sheet(higher)
    : XLSX.utils.aoa_to_sheet([[`No tissue type has at least ${MIN_TILES} tiles and ${MIN_TILES} other tiles to compare.`]]);
  higherSheet["!cols"] = [{ wch: 18 }, { wch: 6 }, { wch: 20 }, { wch: 13 }, { wch: 19 }, { wch: 11 }];
  XLSX.utils.book_append_sheet(workbook, higherSheet, "Genes higher by tissue type");

  return workbook;
}

export function exportGeneExpressionExcel(pred: Prediction, sourceName?: string) {
  const workbook = buildGeneExpressionWorkbook(pred);
  const base = sourceName ? sourceName.replace(/\.[^.]+$/, "") : "genex";
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
  XLSX.writeFile(workbook, `${base}-gene-expression-${stamp}.xlsx`);
}
