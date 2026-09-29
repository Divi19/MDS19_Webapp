"use client";

import { useRef, useState } from "react";

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
    if (f.size > 50 * 1024 * 1024) {
      setFile(null);
      setStatus({ text: "Too large (50 MB max)", color: "#c0392b" });
      return;
    }
    setFile(f);
    setName(f.name);
    setSizeLabel(fmtBytes(f.size));
    setStatus({ text: "Ready", color: "var(--accent)" });
    setDims(DASH);
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
            <div className="pretitle">Step 1 · Input</div>
            <h2>Upload an H&amp;E section</h2>
          </div>
          <button className="modal-close" onClick={onClose} aria-label="Close">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>

        <div className="modal-body" data-tour={open ? "upload-body" : undefined}>
          <label
            className={`dropzone${dragging ? " dragging" : ""}`}
            onDragEnter={(e) => {
              e.preventDefault();
              setDragging(true);
            }}
            onDragOver={(e) => {
              e.preventDefault();
              setDragging(true);
            }}
            onDragLeave={(e) => {
              e.preventDefault();
              setDragging(false);
            }}
            onDrop={(e) => {
              e.preventDefault();
              setDragging(false);
              handleFile(e.dataTransfer.files?.[0]);
            }}
          >
            <input
              ref={inputRef}
              type="file"
              accept=".tif,.tiff,.png,.jpg,.jpeg"
              onChange={(e) => handleFile(e.target.files?.[0])}
            />
            {url ? (
              <div className="dropzone-preview">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={url} alt="uploaded H&E section preview" />
                <div className="dropzone-sub">{name} · click to choose a different image</div>
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
                <div className="dropzone-sub">or click to browse · max 50 MB</div>
                <div className="format-pills">
                  <span>.tif</span>
                  <span>.tiff</span>
                  <span>.png</span>
                  <span>.jpg</span>
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
            data-tour={open ? "upload-run" : undefined}
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
