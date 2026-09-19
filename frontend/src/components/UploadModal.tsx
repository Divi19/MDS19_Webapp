"use client";

import { useRef, useState } from "react";
import { makeDemoHE } from "@/lib/demoImage";

export interface RunPayload {
  name: string;
  sizeLabel: string;
  url: string | null;
  file: File | null;
  her2PositiveBreastTissueConfirmed: boolean;
  heStainConfirmed: boolean;
  micronsPerPixel: number;
  syntheticDemo: boolean;
}

function fmtBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1048576).toFixed(2)} MB`;
}

const DASH = "—";

export default function UploadModal({
  open,
  onClose,
  onRun,
}: {
  open: boolean;
  onClose: () => void;
  onRun: (payload: RunPayload) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const [name, setName] = useState(DASH);
  const [sizeLabel, setSizeLabel] = useState(DASH);
  const [dims, setDims] = useState(DASH);
  const [url, setUrl] = useState<string | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [her2Confirmed, setHer2Confirmed] = useState(false);
  const [heConfirmed, setHeConfirmed] = useState(false);
  const [mpp, setMpp] = useState("");
  const [syntheticDemo, setSyntheticDemo] = useState(false);
  const [fileError, setFileError] = useState("");

  function handleFile(selected: File | undefined | null) {
    if (!selected) return;
    if (selected.size > 50 * 1024 * 1024) {
      setFile(null);
      setFileError("File exceeds the 50 MB limit");
      return;
    }
    setFile(selected);
    setName(selected.name);
    setSizeLabel(fmtBytes(selected.size));
    setDims(DASH);
    setFileError("");
    setSyntheticDemo(false);
    const reader = new FileReader();
    reader.onload = (event) => {
      const src = event.target?.result as string;
      setUrl(src);
      const image = new Image();
      image.onload = () => setDims(`${image.naturalWidth} × ${image.naturalHeight}`);
      image.src = src;
    };
    reader.readAsDataURL(selected);
  }

  async function loadDemo() {
    const demoUrl = makeDemoHE();
    const blob = await fetch(demoUrl).then((response) => response.blob());
    const demoFile = new File([blob], "synthetic-canvas-demo.png", { type: "image/png" });
    setFile(demoFile);
    setName(demoFile.name);
    setSizeLabel(fmtBytes(demoFile.size));
    setDims("320 × 240");
    setUrl(demoUrl);
    setSyntheticDemo(true);
    setHer2Confirmed(false);
    setHeConfirmed(false);
    setMpp("1");
    setFileError("");
  }

  const parsedMpp = Number(mpp);
  const validMpp = mpp.trim() !== "" && Number.isFinite(parsedMpp) && parsedMpp >= 0.05 && parsedMpp <= 10;
  const confirmationsComplete = her2Confirmed && heConfirmed;
  const canRun = Boolean(file) && validMpp && (syntheticDemo || confirmationsComplete);

  return (
    <div
      className={`modal-backdrop${open ? " visible" : ""}`}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="modal upload-modal" role="dialog" aria-modal="true" aria-labelledby="upload-title">
        <div className="modal-header">
          <div>
            <div className="pretitle">Research input · required metadata</div>
            <h2 id="upload-title">Run model-scale predicted expression</h2>
          </div>
          <button className="modal-close" onClick={onClose} aria-label="Close">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>

        <div className="modal-body">
          <div className="scope-notice">
            <strong>HER2-positive breast tissue only.</strong>
            <span>This model is limited to H&amp;E sections within that reference scope. Outputs are for research use only and must not guide clinical decisions.</span>
          </div>

          <label
            className={`dropzone${dragging ? " dragging" : ""}`}
            onDragEnter={(event) => {
              event.preventDefault();
              setDragging(true);
            }}
            onDragOver={(event) => {
              event.preventDefault();
              setDragging(true);
            }}
            onDragLeave={(event) => {
              event.preventDefault();
              setDragging(false);
            }}
            onDrop={(event) => {
              event.preventDefault();
              setDragging(false);
              handleFile(event.dataTransfer.files?.[0]);
            }}
          >
            <input
              ref={inputRef}
              type="file"
              accept=".tif,.tiff,.png,.jpg,.jpeg"
              onChange={(event) => handleFile(event.target.files?.[0])}
            />
            {url ? (
              <div className="dropzone-preview">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={url} alt={syntheticDemo ? "synthetic canvas illustration" : "uploaded H&E section preview"} />
                <div className="dropzone-sub">{name} · choose a different image</div>
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
                <div className="dropzone-title">Drop an H&amp;E image here</div>
                <div className="dropzone-sub">TIFF, PNG, or JPEG · maximum 50 MB</div>
              </>
            )}
          </label>

          {fileError && <div className="form-error">{fileError}</div>}
          {syntheticDemo && (
            <div className="synthetic-warning">
              Synthetic canvas illustration · demo mode only. It is not a tissue section and real mode may reject it.
            </div>
          )}

          <div className="preview-meta">
            <div className="meta-tile"><div className="label">Filename</div><div className="value">{name}</div></div>
            <div className="meta-tile"><div className="label">Size</div><div className="value">{sizeLabel}</div></div>
            <div className="meta-tile"><div className="label">Dimensions</div><div className="value">{dims}</div></div>
            <label className="meta-tile mpp-field">
              <span className="label">Microns per pixel</span>
              <input
                type="number"
                min="0.05"
                max="10"
                step="0.01"
                inputMode="decimal"
                value={mpp}
                onChange={(event) => setMpp(event.target.value)}
                placeholder="e.g. 0.50"
              />
            </label>
          </div>

          {!syntheticDemo && (
            <div className="confirmations">
              <label>
                <input type="checkbox" checked={her2Confirmed} onChange={(event) => setHer2Confirmed(event.target.checked)} />
                <span>I explicitly confirm this is HER2-positive breast tissue.</span>
              </label>
              <label>
                <input type="checkbox" checked={heConfirmed} onChange={(event) => setHeConfirmed(event.target.checked)} />
                <span>I explicitly confirm this section uses H&amp;E stain.</span>
              </label>
            </div>
          )}

          <div className="demo-line">
            Interface evaluation only: <button onClick={loadDemo}>load unmistakably synthetic canvas demo</button>
          </div>
        </div>

        <div className="modal-footer">
          <span className="hint">Raw metadata is sent with the multipart request.</span>
          <button className="btn-secondary" onClick={onClose}>Cancel</button>
          <button
            className="run-btn"
            disabled={!canRun}
            onClick={() => onRun({
              name,
              sizeLabel,
              url,
              file,
              her2PositiveBreastTissueConfirmed: her2Confirmed,
              heStainConfirmed: heConfirmed,
              micronsPerPixel: parsedMpp,
              syntheticDemo,
            })}
          >
            {syntheticDemo ? "Run synthetic demo request" : "Run research prediction"}
          </button>
        </div>
      </div>
    </div>
  );
}
