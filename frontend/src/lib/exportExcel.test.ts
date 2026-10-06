import * as XLSX from "xlsx";
import { describe, expect, it } from "vitest";
import { toPrediction } from "@/lib/api";
import { buildGeneExpressionWorkbook } from "@/lib/exportExcel";
import { OLD_RESPONSE, TISSUE_RESPONSE } from "@/test/fixtures";

const rows = (wb: XLSX.WorkBook, name: string) => XLSX.utils.sheet_to_json<Record<string, unknown>>(wb.Sheets[name]);

describe("Excel export", () => {
  it("keeps only the ranked gene sheet for a prediction without tissue types", () => {
    const wb = buildGeneExpressionWorkbook(toPrediction(OLD_RESPONSE));
    expect(wb.SheetNames).toEqual(["Predicted gene expression"]);
    expect(rows(wb, "Predicted gene expression")[0]).toMatchObject({ Rank: 1, Gene: "ERBB2" });
  });

  it("adds per-class gene means and a per-tile sheet when tissue types exist", () => {
    const wb = buildGeneExpressionWorkbook(toPrediction(TISSUE_RESPONSE));
    expect(wb.SheetNames).toEqual(["Predicted gene expression", "Expression by tissue type", "Tiles"]);

    const byTissue = rows(wb, "Expression by tissue type");
    expect(byTissue[0]).toMatchObject({ Gene: "ERBB2", Cancer: 2, "Adipose tissue": 1.5 });
    expect(byTissue[0]["Immune infiltrate"] ?? null).toBeNull();
    expect(byTissue.at(-1)).toMatchObject({ Gene: "Tiles (n)", Cancer: 3, "Adipose tissue": 1, "Immune infiltrate": 0 });

    const tiles = rows(wb, "Tiles");
    expect(tiles).toHaveLength(4);
    expect(tiles[0]).toMatchObject({ Tile: 1, "Tissue type": "Cancer", Confidence: 0.9, "P(Cancer)": 0.9 });
  });
});
