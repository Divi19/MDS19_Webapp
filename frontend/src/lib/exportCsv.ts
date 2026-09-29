import type { PredictionResponse } from "@/lib/api";

function csvCell(value: string | number): string {
  const s = String(value);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** One row per spot: spot_index, x, y, then one column per gene with raw predicted expression. */
export function buildPredictionCsv(response: PredictionResponse): string {
  const genes = Array.from(
    new Set(response.spots.flatMap((spot) => Object.keys(spot.expression))),
  );
  const header = ["spot_index", "x", "y", ...genes].map(csvCell).join(",");
  const rows = response.spots.map((spot) =>
    [spot.spot_index, spot.x, spot.y, ...genes.map((g) => spot.expression[g] ?? "")]
      .map(csvCell)
      .join(","),
  );
  return [header, ...rows].join("\n");
}

export function downloadPredictionCsv(response: PredictionResponse, sourceName?: string) {
  const base = (sourceName ?? response.prediction_id).replace(/\.[^.]+$/, "") || "prediction";
  const blob = new Blob([buildPredictionCsv(response)], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${base}_spot_expression.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
