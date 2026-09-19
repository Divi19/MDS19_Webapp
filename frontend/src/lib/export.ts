import { requestExportBundle } from "@/lib/api";
import type { ExportROIGeometry, PredictionResponse, PredictionTile } from "@/lib/types";

function tileIndex(tile: PredictionTile): number {
  return tile.tile_index ?? tile.spot_index;
}

function validBounds(tile: PredictionTile) {
  const bounds = tile.bounds;
  if (!bounds) return null;
  const values = [bounds.left, bounds.top, bounds.right, bounds.bottom];
  if (!values.every(Number.isFinite) || bounds.right <= bounds.left || bounds.bottom <= bounds.top) return null;
  return bounds;
}

function roiGeometry(
  prediction: PredictionResponse,
  group: "A" | "B",
  selected: number[],
): ExportROIGeometry | null {
  const selectedSet = new Set(selected);
  const boundedTiles = prediction.prediction_tiles
    .filter((tile) => selectedSet.has(tileIndex(tile)))
    .flatMap((tile) => {
      const bounds = validBounds(tile);
      return bounds ? [{ tile, bounds }] : [];
    })
    .sort((first, second) => tileIndex(first.tile) - tileIndex(second.tile));
  if (!boundedTiles.length) return null;
  return {
    roi_id: `roi-${group.toLowerCase()}`,
    tile_indices: boundedTiles.map(({ tile }) => tileIndex(tile)),
    geometry: {
      type: "MultiPolygon",
      coordinates: boundedTiles.map(({ bounds }) => [[
        [bounds.left, bounds.top],
        [bounds.right, bounds.top],
        [bounds.right, bounds.bottom],
        [bounds.left, bounds.bottom],
        [bounds.left, bounds.top],
      ]]),
    },
    properties: {
      group,
      geometry_source: "returned_prediction_tile_bounds",
      bounds_units: prediction.coordinate_metadata.bounds_units,
    },
  };
}

export function buildROIGeometries(
  prediction: PredictionResponse,
  selectedA: number[],
  selectedB: number[],
): ExportROIGeometry[] {
  return [
    roiGeometry(prediction, "A", selectedA),
    roiGeometry(prediction, "B", selectedB),
  ].filter((item): item is ExportROIGeometry => item !== null);
}

function safeName(value: string): string {
  const normalized = value.trim().replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return normalized || "prediction";
}

export function downloadBlob(blob: Blob, filename: string): string {
  if (!(blob instanceof Blob) || blob.size === 0) throw new Error(`Cannot download empty file ${filename}.`);
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.style.display = "none";
  document.body.appendChild(anchor);
  try {
    anchor.click();
  } finally {
    anchor.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  return filename;
}

export async function downloadBackendBundle(
  prediction: PredictionResponse,
  selectedA: number[],
  selectedB: number[],
): Promise<string> {
  const blob = await requestExportBundle({
    prediction,
    roi_geometries: buildROIGeometries(prediction, selectedA, selectedB),
  });
  if (blob.type && !blob.type.toLowerCase().includes("zip")) {
    throw new Error(`The backend returned ${blob.type} instead of a ZIP export.`);
  }
  return downloadBlob(blob, `${safeName(prediction.prediction_id)}-research-export.zip`);
}

function canvasPNG(canvas: HTMLCanvasElement): Promise<Blob> {
  if (!canvas.width || !canvas.height) return Promise.reject(new Error("The tissue viewer canvas is not ready."));
  return new Promise((resolve, reject) => {
    try {
      canvas.toBlob((blob) => {
        if (blob?.size) resolve(blob);
        else reject(new Error("The tissue viewer could not create a PNG blob."));
      }, "image/png");
    } catch (error) {
      reject(error instanceof Error ? error : new Error("The tissue viewer could not create a PNG blob."));
    }
  });
}

export async function downloadCurrentViewPNG(
  canvas: HTMLCanvasElement | null,
  predictionId: string,
): Promise<string> {
  if (!canvas) throw new Error("The tissue viewer canvas is not available.");
  const blob = await canvasPNG(canvas);
  return downloadBlob(blob, `${safeName(predictionId)}-tissue-view.png`);
}
