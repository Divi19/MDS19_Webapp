import * as XLSX from "xlsx";
import type { Prediction } from "@/lib/mockPrediction";

/** Full ranked gene panel (`pred.topGenes`), not just the current page —
 * matches everything the paginated table/cards would show across all pages. */
export function exportGeneExpressionExcel(pred: Prediction, sourceName?: string) {
  const rows = pred.topGenes.map((g, i) => ({
    Rank: i + 1,
    Gene: g.name,
    "Mean expression": Number(g.value.toFixed(4)),
    Level: g.level,
  }));

  const sheet = XLSX.utils.json_to_sheet(rows);
  sheet["!cols"] = [{ wch: 6 }, { wch: 14 }, { wch: 16 }, { wch: 8 }];

  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, sheet, "Predicted gene expression");

  const base = sourceName ? sourceName.replace(/\.[^.]+$/, "") : "genex";
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
  XLSX.writeFile(workbook, `${base}-gene-expression-${stamp}.xlsx`);
}
