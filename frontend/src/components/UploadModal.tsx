"use client";

import { useRef, useState } from "react";
import TissueThumb from "./TissueThumb";

export interface RunPayload {
  name: string;
  sizeLabel: string;
  url: string | null;
  file: File | null;
}

function fmtBytes(b: number) {
  if (b < 1024) return `${b} B`;
  if (b < 1048576) return `${(b / 1024).toFixed(1)} KB`;
  return `${(b / 1048576).toFixed(2)} MB`;
}

const DASH = "—";

// Whole-slide formats (OpenSlide, backend/app/services/wsi.py) get a much
// higher size ceiling than plain jpeg/png/tiff uploads (500MB vs 50MB,
// MAX_WSI_UPLOAD_BYTES in routes.py) — scanner output runs far larger than a
// flat image. .zip is included here because .mrxs ships as an index file
// plus a sibling data folder; a browser upload can only carry one file, so a
// .mrxs slide has to be zipped together with its folder first.
const WSI_EXTENSIONS = [".svs", ".ndpi", ".scn", ".vms", ".vmu", ".svslide", ".bif", ".zip"];
const WSI_MAX_BYTES = 500 * 1024 * 1024;
const STANDARD_MAX_BYTES = 50 * 1024 * 1024;

function isWsiFile(f: File): boolean {
  const name = f.name.toLowerCase();
  return WSI_EXTENSIONS.some((ext) => name.endsWith(ext));
}

export default function UploadModal({
  open,
  onClose,
  onRun,
  inline = false,
}: {
  open: boolean;
  onClose: () => void;
  onRun: (payload: RunPayload) => void;
  /** Render the landing page's capture frame instead of the modal. Same
   * upload state and handlers either way. */
  inline?: boolean;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const [name, setName] = useState(DASH);
  const [sizeLabel, setSizeLabel] = useState(DASH);
  const [dims, setDims] = useState(DASH);
  const [status, setStatus] = useState<{ text: string; color: string }>({
    text: "No file",
    color: "var(--muted2)",
  });
  const [url, setUrl] = useState<string | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [loadingSample, setLoadingSample] = useState(false);

  async function loadSample() {
    setLoadingSample(true);
    try {
      const res = await fetch("/sample-he-section.jpg");
      const blob = await res.blob();
      handleFile(new File([blob], "sample-he-section.jpg", { type: blob.type || "image/jpeg" }));
    } catch {
      setStatus({ text: "Couldn't load the sample image", color: "#c0392b" });
    } finally {
      setLoadingSample(false);
    }
  }

  function handleFile(f: File | undefined | null) {
    if (!f) return;
    const wsi = isWsiFile(f);
    const maxBytes = wsi ? WSI_MAX_BYTES : STANDARD_MAX_BYTES;
    if (f.size > maxBytes) {
      setFile(null);
      setStatus({ text: `Too large (${maxBytes / (1024 * 1024)} MB max)`, color: "#c0392b" });
      return;
    }
    setFile(f);
    setName(f.name);
    setSizeLabel(fmtBytes(f.size));
    setStatus({ text: "Ready", color: "var(--accent)" });
    setDims(DASH);

    // Whole-slide formats (.svs/.ndpi/...) can't be decoded by the browser's
    // <img>/Image() — they're flattened server-side (wsi.py) during predict.
    // Skip the preview/dims read entirely rather than show a broken image.
    if (wsi) {
      setUrl(null);
      return;
    }
    const reader = new FileReader();
    reader.onload = (e) => {
      const src = e.target?.result as string;
      setUrl(src);
      const im = new Image();
      im.onload = () => setDims(`${im.naturalWidth} × ${im.naturalHeight}`);
      im.src = src;
    };
    reader.readAsDataURL(f);
  }

  const canRun = status.text !== "No file";

  const dropProps = {
    onDragEnter: (e: React.DragEvent) => {
      e.preventDefault();
      setDragging(true);
    },
    onDragOver: (e: React.DragEvent) => {
      e.preventDefault();
      setDragging(true);
    },
    onDragLeave: (e: React.DragEvent) => {
      e.preventDefault();
      setDragging(false);
    },
    onDrop: (e: React.DragEvent) => {
      e.preventDefault();
      setDragging(false);
      handleFile(e.dataTransfer.files?.[0]);
    },
  };
  const fileInput = (
    <input
      ref={inputRef}
      type="file"
      accept=".tif,.tiff,.png,.jpg,.jpeg,.svs,.ndpi,.scn,.vms,.vmu,.svslide,.bif,.zip"
      onChange={(e) => handleFile(e.target.files?.[0])}
    />
  );

  if (inline) {
    return (
      <div className="capture">
        <label className={`capture-frame${dragging ? " dragging" : ""}${file ? " filled" : ""}`} {...dropProps}>
          <span className="corner tl" />
          <span className="corner tr" />
          <span className="corner bl" />
          <span className="corner br" />
          {fileInput}
          {url ? (
            <TissueThumb url={url} alt="uploaded H&E section preview" />
          ) : file ? (
            <div className="capture-hint">
              <div className="capture-title">Whole-slide image</div>
              <div className="capture-sub">No preview for this format</div>
            </div>
          ) : (
            <div className="capture-hint">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                <polyline points="17 8 12 3 7 8" />
                <line x1="12" y1="3" x2="12" y2="15" />
              </svg>
              <div className="capture-title">Drop a histology image here</div>
              <div className="capture-sub">or click to browse</div>
            </div>
          )}
        </label>

        {file ? (
          <div className="capture-sheet glass">
            <div className="sheet-top">
              <div className="sheet-name">{name}</div>
              <span className="sheet-status" style={{ color: status.color }}>
                {status.text}
              </span>
            </div>
            <div className="sheet-meta">
              {dims !== DASH && <span>{dims}</span>}
              <span>{sizeLabel}</span>
              <span>TIFF, PNG, JPEG, SVS, NDPI</span>
            </div>
            <div className="sheet-actions">
              <button type="button" className="btn-secondary" onClick={() => inputRef.current?.click()}>
                Choose another
              </button>
              <button
                type="button"
                className="run-btn"
                disabled={!canRun}
                onClick={() => onRun({ name, sizeLabel, url, file })}
              >
                Run prediction
              </button>
            </div>
          </div>
        ) : (
          <div className="capture-foot">
            <span>Up to 50 MB, whole-slide formats up to 500 MB</span>
            <button type="button" className="sample-link" onClick={loadSample} disabled={loadingSample}>
              {loadingSample ? "Loading sample…" : "Try a sample section"}
            </button>
            {status.text !== "No file" && <span style={{ color: status.color }}>{status.text}</span>}
          </div>
        )}
      </div>
    );
  }

  return (
    <div
      className={`modal-backdrop${open ? " visible" : ""}`}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="modal" role="dialog" aria-modal="true">
        <div className="modal-header">
          <div>
            <div className="pretitle">Input</div>
            <h2>Upload an H&amp;E section</h2>
          </div>
          <button className="modal-close" onClick={onClose} aria-label="Close">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>

        <div className="modal-body" data-tour={open && !inline ? "upload-body" : undefined}>
          <label className={`dropzone${dragging ? " dragging" : ""}`} {...dropProps}>
            {fileInput}
            {url ? (
              <div className="dropzone-preview">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={url} alt="uploaded H&E section preview" />
                <div className="dropzone-sub">{name} · click to choose a different image</div>
              </div>
            ) : file ? (
              <div className="dropzone-preview">
                <div className="dropzone-icon">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
                    <rect x="3" y="3" width="18" height="18" rx="2" />
                    <circle cx="8.5" cy="8.5" r="1.5" />
                    <path d="M21 15l-5-5L5 21" />
                  </svg>
                </div>
                <div className="dropzone-sub">{name} · whole-slide image · click to choose a different file</div>
              </div>
            ) : (
              <>
                <div className="dropzone-icon">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                    <polyline points="17 8 12 3 7 8" />
                    <line x1="12" y1="3" x2="12" y2="15" />
                  </svg>
                </div>
                <div className="dropzone-title">Drop a histology image here</div>
                <div className="dropzone-sub">or click to browse · max 50 MB (whole-slide formats up to 500 MB)</div>
                <div className="format-pills">
                  <span>.tif</span>
                  <span>.tiff</span>
                  <span>.png</span>
                  <span>.jpg</span>
                  <span>.svs</span>
                  <span>.ndpi</span>
                  <span>.mrxs (.zip)</span>
                </div>
              </>
            )}
          </label>

          <button type="button" className="sample-link" onClick={loadSample} disabled={loadingSample}>
            {loadingSample ? "Loading sample…" : "Don't have a section handy? Try a sample H&E image"}
          </button>

          <div className="preview-meta">
            <div className="meta-tile">
              <div className="label">Filename</div>
              <div className="value">{name}</div>
            </div>
            <div className="meta-tile">
              <div className="label">Size</div>
              <div className="value">{sizeLabel}</div>
            </div>
            <div className="meta-tile">
              <div className="label">Dimensions</div>
              <div className="value">{dims}</div>
            </div>
            <div className="meta-tile">
              <div className="label">Status</div>
              <div className="value" style={{ color: status.color }}>
                {status.text}
              </div>
            </div>
          </div>

        </div>

        <div className="modal-footer">
          <span className="hint" />
          <button className="btn-secondary" onClick={onClose}>
            Cancel
          </button>
          <button
            className="run-btn"
            data-tour={open && !inline ? "upload-run" : undefined}
            disabled={!canRun}
            onClick={() => onRun({ name, sizeLabel, url, file })}
          >
            Run prediction
          </button>
        </div>
      </div>
    </div>
  );
}
