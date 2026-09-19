"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react";
import type { PredictionResponse, PredictionTile } from "@/lib/types";

export type ViewerMode = "image" | "gene" | "domains" | "retrieval";
export type ROIGroup = "A" | "B";

const DOMAIN_COLORS = ["#0f766e", "#c2410c", "#6d28d9", "#0369a1", "#be123c", "#4d7c0f", "#a16207", "#4338ca"];
const VIRIDIS = [
  [68, 1, 84],
  [59, 82, 139],
  [33, 145, 140],
  [94, 201, 98],
  [253, 231, 37],
];

function colorScale(value: number, low: number, high: number) {
  const t = high === low ? 0.5 : Math.max(0, Math.min(1, (value - low) / (high - low)));
  const scaled = t * (VIRIDIS.length - 1);
  const index = Math.floor(scaled);
  const fraction = scaled - index;
  const first = VIRIDIS[index];
  const second = VIRIDIS[Math.min(index + 1, VIRIDIS.length - 1)];
  return `rgb(${Math.round(first[0] + (second[0] - first[0]) * fraction)}, ${Math.round(first[1] + (second[1] - first[1]) * fraction)}, ${Math.round(first[2] + (second[2] - first[2]) * fraction)})`;
}

function numeric(value: number | null | undefined) {
  return value == null || !Number.isFinite(value) ? "—" : value.toPrecision(5);
}

interface HoverState {
  left: number;
  top: number;
  tile: PredictionTile;
}

export default function SpatialPlot({
  prediction,
  imageUrl,
  mode,
  gene,
  onModeChange,
  selectedA,
  selectedB,
  activeROIGroup,
  onTileToggle,
  canvasRef,
}: {
  prediction: PredictionResponse;
  imageUrl: string | null;
  mode: ViewerMode;
  gene: string;
  onModeChange: (mode: ViewerMode) => void;
  selectedA: number[];
  selectedB: number[];
  activeROIGroup: ROIGroup | null;
  onTileToggle: (tileIndex: number, group: ROIGroup) => void;
  canvasRef: RefObject<HTMLCanvasElement | null>;
}) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const [loadedImage, setLoadedImage] = useState<{ url: string; element: HTMLImageElement } | null>(null);
  const [width, setWidth] = useState(760);
  const [imageOpacity, setImageOpacity] = useState(1);
  const [overlayOpacity, setOverlayOpacity] = useState(0.7);
  const [hover, setHover] = useState<HoverState | null>(null);

  const tiles = prediction.prediction_tiles.length ? prediction.prediction_tiles : prediction.spots;
  const imageWidth = prediction.image_metadata.width_pixels;
  const imageHeight = prediction.image_metadata.height_pixels;
  const ratio = imageWidth > 0 ? imageHeight / imageWidth : 0.75;
  const height = Math.max(220, Math.round(width * ratio));
  const demoMode = prediction.model_metadata.mode === "demo";
  const domainByTile = useMemo(
    () => new Map(prediction.domain_assignments.map((item) => [item.tile_index, item.domain_id])),
    [prediction.domain_assignments],
  );
  const domainIds = useMemo(
    () => Array.from(new Set(prediction.domain_assignments.map((item) => item.domain_id))).sort(),
    [prediction.domain_assignments],
  );
  const selectedASet = useMemo(() => new Set(selectedA), [selectedA]);
  const selectedBSet = useMemo(() => new Set(selectedB), [selectedB]);
  const demoExtent = useMemo(() => {
    const xs = tiles.map((tile) => tile.x);
    const ys = tiles.map((tile) => tile.y);
    return {
      minX: Math.min(...xs),
      maxX: Math.max(...xs),
      minY: Math.min(...ys),
      maxY: Math.max(...ys),
    };
  }, [tiles]);
  const tileGeometry = useCallback((tile: PredictionTile) => {
    if (!demoMode) {
      const left = tile.bounds?.left ?? tile.x - imageWidth * 0.006;
      const top = tile.bounds?.top ?? tile.y - imageHeight * 0.006;
      const right = tile.bounds?.right ?? tile.x + imageWidth * 0.006;
      const bottom = tile.bounds?.bottom ?? tile.y + imageHeight * 0.006;
      return { x: tile.x, y: tile.y, left, top, right, bottom };
    }
    const spanX = demoExtent.maxX - demoExtent.minX;
    const spanY = demoExtent.maxY - demoExtent.minY;
    const x = imageWidth * (0.04 + 0.92 * (spanX ? (tile.x - demoExtent.minX) / spanX : 0.5));
    const y = imageHeight * (0.04 + 0.92 * (spanY ? (tile.y - demoExtent.minY) / spanY : 0.5));
    const size = Math.max(4, Math.min(imageWidth, imageHeight) / Math.max(8, Math.sqrt(tiles.length) * 1.6));
    return { x, y, left: x - size / 2, top: y - size / 2, right: x + size / 2, bottom: y + size / 2 };
  }, [demoExtent, demoMode, imageHeight, imageWidth, tiles.length]);

  const scale = useMemo(() => {
    const values = tiles
      .map((tile) =>
        mode === "gene"
          ? tile.expression[gene]
          : tile.retrieval_support?.max_selected_cosine_similarity,
      )
      .filter((value): value is number => typeof value === "number" && Number.isFinite(value));
    return {
      low: values.length ? Math.min(...values) : 0,
      high: values.length ? Math.max(...values) : 0,
    };
  }, [gene, mode, tiles]);

  useEffect(() => {
    const element = wrapRef.current;
    if (!element) return;
    const observer = new ResizeObserver(() => setWidth(element.clientWidth || 760));
    observer.observe(element);
    setWidth(element.clientWidth || 760);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!imageUrl) return;
    const image = new Image();
    image.onload = () => setLoadedImage({ url: imageUrl, element: image });
    image.src = imageUrl;
    return () => {
      image.onload = null;
    };
  }, [imageUrl]);

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    canvas.style.height = `${height}px`;
    const context = canvas.getContext("2d");
    if (!context) return;
    context.setTransform(dpr, 0, 0, dpr, 0, 0);
    context.fillStyle = "#f8f5f2";
    context.fillRect(0, 0, width, height);

    if (loadedImage?.url === imageUrl) {
      context.globalAlpha = imageOpacity;
      context.drawImage(loadedImage.element, 0, 0, width, height);
      context.globalAlpha = 1;
    }

    const xScale = width / imageWidth;
    const yScale = height / imageHeight;
    for (const tile of tiles) {
      const tileIndex = tile.tile_index ?? tile.spot_index;
      const domain = domainByTile.get(tileIndex);
      const geneValue = tile.expression[gene];
      const supportValue = tile.retrieval_support?.max_selected_cosine_similarity;
      let fill: string | null = null;
      if (mode === "gene" && Number.isFinite(geneValue)) fill = colorScale(geneValue, scale.low, scale.high);
      if (mode === "retrieval" && Number.isFinite(supportValue)) fill = colorScale(supportValue ?? 0, scale.low, scale.high);
      if (mode === "domains" && domain) {
        const domainIndex = domainIds.indexOf(domain);
        fill = DOMAIN_COLORS[(domainIndex < 0 ? 0 : domainIndex) % DOMAIN_COLORS.length];
      }

      const geometry = tileGeometry(tile);
      const left = geometry.left * xScale;
      const top = geometry.top * yScale;
      const tileWidth = Math.max(3, (geometry.right - geometry.left) * xScale);
      const tileHeight = Math.max(3, (geometry.bottom - geometry.top) * yScale);

      if (fill) {
        context.globalAlpha = overlayOpacity;
        context.fillStyle = fill;
        context.fillRect(left, top, tileWidth, tileHeight);
        context.globalAlpha = 1;
      }

      if (selectedASet.has(tileIndex) || selectedBSet.has(tileIndex)) {
        context.strokeStyle = selectedASet.has(tileIndex) ? "#00d4ff" : "#ffb000";
        context.lineWidth = 2.5;
        context.strokeRect(left + 1, top + 1, Math.max(1, tileWidth - 2), Math.max(1, tileHeight - 2));
      }
    }
  }, [canvasRef, domainByTile, domainIds, gene, height, imageHeight, imageOpacity, imageUrl, imageWidth, loadedImage, mode, overlayOpacity, scale.high, scale.low, selectedASet, selectedBSet, tileGeometry, tiles, width]);

  useEffect(() => draw(), [draw]);

  function locateTile(event: React.MouseEvent<HTMLCanvasElement>) {
    const canvas = canvasRef.current;
    if (!canvas) return null;
    const rect = canvas.getBoundingClientRect();
    const sourceX = ((event.clientX - rect.left) / rect.width) * imageWidth;
    const sourceY = ((event.clientY - rect.top) / rect.height) * imageHeight;
    const within = tiles.find((tile) => {
      const geometry = tileGeometry(tile);
      return sourceX >= geometry.left && sourceX <= geometry.right && sourceY >= geometry.top && sourceY <= geometry.bottom;
    });
    if (within) return within;
    let nearest: PredictionTile | null = null;
    let nearestDistance = Number.POSITIVE_INFINITY;
    for (const tile of tiles) {
      const geometry = tileGeometry(tile);
      const distance = (sourceX - geometry.x) ** 2 + (sourceY - geometry.y) ** 2;
      if (distance < nearestDistance) {
        nearest = tile;
        nearestDistance = distance;
      }
    }
    const threshold = Math.max(imageWidth, imageHeight) * 0.025;
    return nearestDistance <= threshold ** 2 ? nearest : null;
  }

  function handleMove(event: React.MouseEvent<HTMLCanvasElement>) {
    const tile = locateTile(event);
    if (!tile) {
      setHover(null);
      return;
    }
    const rect = event.currentTarget.getBoundingClientRect();
    setHover({ left: event.clientX - rect.left, top: event.clientY - rect.top, tile });
  }

  function handleClick(event: React.MouseEvent<HTMLCanvasElement>) {
    if (!activeROIGroup) return;
    const tile = locateTile(event);
    if (tile?.tile_index != null) onTileToggle(tile.tile_index, activeROIGroup);
  }

  const hoverIndex = hover?.tile.tile_index ?? hover?.tile.spot_index;
  const hoverDomain = hoverIndex == null ? null : domainByTile.get(hoverIndex);
  const hoverSupport = hover?.tile.retrieval_support;

  return (
    <section className="viewer-panel" aria-label="H&E and prediction tile viewer">
      <div className="viewer-toolbar">
        <div className="viewer-modes" role="group" aria-label="Viewer layer">
          {(["image", "gene", "domains", "retrieval"] as ViewerMode[]).map((item) => (
            <button key={item} className={mode === item ? "active" : ""} onClick={() => onModeChange(item)}>
              {item === "image" ? "H&E" : item === "gene" ? "Gene overlay" : item === "domains" ? "Domains" : "Retrieval support"}
            </button>
          ))}
        </div>
        <div className="opacity-controls">
          <label>Image <input type="range" min="0" max="1" step="0.05" value={imageOpacity} onChange={(event) => setImageOpacity(Number(event.target.value))} /></label>
          <label>Overlay <input type="range" min="0" max="1" step="0.05" value={overlayOpacity} onChange={(event) => setOverlayOpacity(Number(event.target.value))} /></label>
        </div>
      </div>

      <div className={`spatial-canvas-wrap${activeROIGroup ? " selecting" : ""}`} ref={wrapRef}>
        <canvas
          ref={canvasRef}
          onMouseMove={handleMove}
          onMouseLeave={() => setHover(null)}
          onClick={handleClick}
          aria-label="Original H&E image with prediction tile overlay"
        />
        {!imageUrl && <div className="image-unavailable">Original image is unavailable for this response.</div>}
        <div className={`viewer-badge ${demoMode ? "synthetic" : ""}`}>
          {demoMode ? "Synthetic demo · normalized display grid" : "Original image pixels"}
        </div>
        {activeROIGroup && <div className="selection-badge">Selecting explicit tile group {activeROIGroup}</div>}
        {hover && (
          <div className="tile-tooltip" style={{ left: hover.left, top: hover.top }}>
            <strong>Prediction tile {hoverIndex}</strong>
            <span>{demoMode ? "Synthetic grid position" : "Original pixels"}: ({numeric(hover.tile.x)}, {numeric(hover.tile.y)})</span>
            <span>{gene}: {numeric(hover.tile.expression[gene])}</span>
            <span>Domain: {hoverDomain ?? "not assigned"}</span>
            <span>Retrieval support max similarity: {numeric(hoverSupport?.max_selected_cosine_similarity)}</span>
            <span>Retrieval support mean similarity: {numeric(hoverSupport?.mean_selected_cosine_similarity)}</span>
            <span>Effective neighbors: {numeric(hoverSupport?.effective_neighbor_count)}</span>
            <span>Expression dispersion: {numeric(hoverSupport?.aggregate_neighbor_expression_dispersion)}</span>
          </div>
        )}
      </div>

      <div className="viewer-legend">
        {mode === "gene" && <><span>{gene} model-scale predicted expression</span><div className="raw-gradient" /><span>{numeric(scale.low)}</span><span>to</span><span>{numeric(scale.high)}</span></>}
        {mode === "retrieval" && <><span>Retrieval support max selected cosine similarity</span><div className="raw-gradient" /><span>{numeric(scale.low)}</span><span>to</span><span>{numeric(scale.high)}</span></>}
        {mode === "domains" && domainIds.map((id, index) => <span className="domain-key" key={id}><i style={{ background: DOMAIN_COLORS[index % DOMAIN_COLORS.length] }} />{id} · predicted-expression domain</span>)}
        {mode === "image" && <span>H&amp;E-first view · overlays remain available without replacing the source image.</span>}
      </div>
    </section>
  );
}
