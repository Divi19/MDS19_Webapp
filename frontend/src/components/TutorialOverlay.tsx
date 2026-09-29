"use client";

import { useEffect, useRef, useState } from "react";
import { TUTORIAL_CHAPTERS, type TutorialPlacement, type TutorialStep } from "@/lib/tutorial";

interface Box {
  top: number;
  left: number;
  width: number;
  height: number;
}

// Space kept around the highlighted element, and between it and the card —
// the arrow sits in that gap.
const PAD = 6;
const GAP = 56;
const MARGIN = 12;

/** All elements marked for a step. A step can highlight several at once
 * (e.g. the first few history entries); the spotlight covers them all. */
function findTargets(target: string | undefined): HTMLElement[] {
  if (!target) return [];
  return Array.from(document.querySelectorAll<HTMLElement>(`[data-tour="${target}"]`));
}

function sameBox(a: Box | null, b: Box | null) {
  if (!a || !b) return a === b;
  return (
    Math.abs(a.top - b.top) < 0.5 &&
    Math.abs(a.left - b.left) < 0.5 &&
    Math.abs(a.width - b.width) < 0.5 &&
    Math.abs(a.height - b.height) < 0.5
  );
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(value, Math.max(min, max)));
}

/** Places the card beside the highlighted element on the first side with
 * room for it, falling back to a corner inside the element when it fills
 * the screen (e.g. a whole column). */
function placeCard(box: Box, card: { width: number; height: number }, preferred?: TutorialPlacement) {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const space: Record<TutorialPlacement, number> = {
    bottom: vh - (box.top + box.height),
    top: box.top,
    right: vw - (box.left + box.width),
    left: box.left,
  };
  const need: Record<TutorialPlacement, number> = {
    bottom: card.height + GAP + MARGIN,
    top: card.height + GAP + MARGIN,
    right: card.width + GAP + MARGIN,
    left: card.width + GAP + MARGIN,
  };
  const order: TutorialPlacement[] = ["bottom", "right", "left", "top"];
  if (preferred) order.unshift(preferred);
  const side = order.find((s) => space[s] >= need[s]);
  const cx = box.left + box.width / 2;
  const cy = box.top + box.height / 2;

  if (!side) {
    return {
      side: null,
      left: clamp(box.left + box.width - card.width - 16, MARGIN, vw - card.width - MARGIN),
      top: clamp(box.top + box.height - card.height - 16, MARGIN, vh - card.height - MARGIN),
      arrowX: 0,
      arrowY: 0,
    };
  }

  let left: number;
  let top: number;
  if (side === "bottom" || side === "top") {
    left = clamp(cx - card.width / 2, MARGIN, vw - card.width - MARGIN);
    top = side === "bottom" ? box.top + box.height + GAP : box.top - GAP - card.height;
  } else {
    top = clamp(cy - card.height / 2, MARGIN, vh - card.height - MARGIN);
    left = side === "right" ? box.left + box.width + GAP : box.left - GAP - card.width;
  }

  // The arrow sits midway across the gap, lined up with the element's centre
  // but never beyond the card's own edge.
  const arrowX =
    side === "bottom" || side === "top"
      ? clamp(cx, left + 24, left + card.width - 24)
      : side === "right"
        ? box.left + box.width + GAP / 2
        : box.left - GAP / 2;
  const arrowY =
    side === "left" || side === "right"
      ? clamp(cy, top + 24, top + card.height - 24)
      : side === "bottom"
        ? box.top + box.height + GAP / 2
        : box.top - GAP / 2;

  return { side, left, top, arrowX, arrowY };
}

// Rotation that points the (upward-drawn) arrow at the element.
const ARROW_ROTATION: Record<TutorialPlacement, number> = { bottom: 0, top: 180, right: -90, left: 90 };

export default function TutorialOverlay({
  step,
  stepNumber,
  stepCount,
  chapterStepNumber,
  chapterStepCount,
  onNext,
  onBack,
  onSkip,
  onTargetActivated,
}: {
  step: TutorialStep;
  stepNumber: number;
  stepCount: number;
  chapterStepNumber: number;
  chapterStepCount: number;
  onNext: () => void;
  onBack: () => void;
  onSkip: () => void;
  /** Called after the user (or Next) clicks the highlighted element on an
   * "advance" step. */
  onTargetActivated: (stepId: string) => void;
}) {
  const cardRef = useRef<HTMLDivElement>(null);
  const primaryRef = useRef<HTMLButtonElement>(null);
  const [box, setBox] = useState<Box | null>(null);
  const [cardSize, setCardSize] = useState({ width: 360, height: 220 });
  const [viewport, setViewport] = useState({ width: 0, height: 0 });

  const isFirst = stepNumber === 1;
  const isLast = stepNumber === stepCount;

  // Track the highlighted element every frame: it can move or resize as
  // modals open, data loads or the window changes, and polling is cheaper
  // and more reliable than observing every possible cause.
  useEffect(() => {
    let frame = 0;
    let scrolled = false;
    let lastBox: Box | null = null;
    const tick = () => {
      const rects = findTargets(step.target)
        .map((element) => element.getBoundingClientRect())
        .filter((rect) => rect.width > 0 && rect.height > 0);
      let next: Box | null = null;
      if (rects.length) {
        const top = Math.min(...rects.map((rect) => rect.top));
        const left = Math.min(...rects.map((rect) => rect.left));
        const bottom = Math.max(...rects.map((rect) => rect.bottom));
        const right = Math.max(...rects.map((rect) => rect.right));
        next = { top, left, width: right - left, height: bottom - top };
        if (!scrolled) {
          scrolled = true;
          findTargets(step.target)[0]?.scrollIntoView({ block: "nearest", inline: "nearest" });
        }
      }
      if (!sameBox(next, lastBox)) {
        lastBox = next;
        setBox(next);
      }
      const card = cardRef.current;
      if (card) {
        const width = card.offsetWidth;
        const height = card.offsetHeight;
        setCardSize((current) => (current.width === width && current.height === height ? current : { width, height }));
      }
      setViewport((current) =>
        current.width === window.innerWidth && current.height === window.innerHeight
          ? current
          : { width: window.innerWidth, height: window.innerHeight },
      );
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [step.target]);

  // Clicks on the highlighted element of an "advance" step move the tutorial
  // on. Deferred so the page's own click handler runs first.
  useEffect(() => {
    if (step.interaction !== "advance") return;
    const stepId = step.id;
    function handleClick(event: MouseEvent) {
      const clicked = event.target;
      if (clicked instanceof Node && findTargets(step.target).some((element) => element.contains(clicked))) {
        window.setTimeout(() => onTargetActivated(stepId), 0);
      }
    }
    document.addEventListener("click", handleClick, true);
    return () => document.removeEventListener("click", handleClick, true);
  }, [step.id, step.interaction, step.target, onTargetActivated]);

  useEffect(() => {
    primaryRef.current?.focus({ preventScroll: true });
  }, [step.id]);

  function next() {
    if (step.interaction === "advance") {
      const [element] = findTargets(step.target);
      if (element) {
        element.click();
        return;
      }
    }
    onNext();
  }

  useEffect(() => {
    function handleKey(event: KeyboardEvent) {
      const tag = (document.activeElement?.tagName ?? "").toUpperCase();
      if (tag === "INPUT" || tag === "TEXTAREA") return;
      if (event.key === "Escape") {
        event.stopPropagation();
        onSkip();
      } else if (event.key === "ArrowRight") {
        event.preventDefault();
        primaryRef.current?.click();
      } else if (event.key === "ArrowLeft" && !isFirst) {
        event.preventDefault();
        onBack();
      }
    }
    window.addEventListener("keydown", handleKey, true);
    return () => window.removeEventListener("keydown", handleKey, true);
  }, [isFirst, onBack, onSkip]);

  const hasTarget = Boolean(step.target && box);
  const hole = box
    ? {
        top: box.top - PAD,
        left: box.left - PAD,
        width: box.width + PAD * 2,
        height: box.height + PAD * 2,
      }
    : null;
  const placement =
    hole && viewport.width ? placeCard(hole, cardSize, step.placement) : null;
  const interactive = hasTarget && Boolean(step.interaction);

  const cardStyle: React.CSSProperties = placement
    ? { left: placement.left, top: placement.top }
    : { left: "50%", top: "50%", transform: "translate(-50%, -50%)" };

  const hint = step.target && !box ? step.missingTargetNote : step.actionHint;
  const primaryLabel = isFirst ? "Begin tutorial" : isLast ? "Finish tutorial" : "Next";

  return (
    <div
      className="tutorial-layer"
      // Keeps page-level "click outside" handlers (menus, the gene popover)
      // from reacting to clicks on the tutorial itself.
      onMouseDown={(event) => event.stopPropagation()}
    >
      {hole ? (
        <div
          className="tutorial-spotlight"
          style={{ top: hole.top, left: hole.left, width: hole.width, height: hole.height }}
        />
      ) : (
        <div className="tutorial-dim" />
      )}

      {/* Click blockers: the whole page, or everything except the highlighted
          element when the step lets the user interact with it. */}
      {interactive && hole ? (
        <>
          <div className="tutorial-blocker" style={{ top: 0, left: 0, right: 0, height: Math.max(0, hole.top) }} />
          <div className="tutorial-blocker" style={{ top: hole.top + hole.height, left: 0, right: 0, bottom: 0 }} />
          <div className="tutorial-blocker" style={{ top: hole.top, left: 0, width: Math.max(0, hole.left), height: hole.height }} />
          <div className="tutorial-blocker" style={{ top: hole.top, left: hole.left + hole.width, right: 0, height: hole.height }} />
        </>
      ) : (
        <div className="tutorial-blocker" style={{ inset: 0 }} />
      )}

      {placement?.side && (
        <div
          className="tutorial-arrow"
          style={{ left: placement.arrowX, top: placement.arrowY, transform: `translate(-50%, -50%) rotate(${ARROW_ROTATION[placement.side]}deg)` }}
          aria-hidden="true"
        >
          <svg viewBox="0 0 32 32" fill="none">
            <path d="M16 3 L29 17 H20.5 V29 H11.5 V17 H3 Z" fill="currentColor" stroke="#fff" strokeWidth="1.6" strokeLinejoin="round" />
          </svg>
        </div>
      )}

      <div
        ref={cardRef}
        className="tutorial-card"
        style={cardStyle}
        role="dialog"
        aria-modal="true"
        aria-labelledby="tutorial-title"
        aria-describedby="tutorial-body"
      >
        <div className="tutorial-card-head">
          <span className="tutorial-chapter">
            Chapter {step.chapter} of {TUTORIAL_CHAPTERS.length} · {TUTORIAL_CHAPTERS[step.chapter - 1]}
          </span>
          <span className="tutorial-count">
            {stepNumber} / {stepCount}
          </span>
        </div>
        <div className="tutorial-progress" aria-hidden="true">
          {Array.from({ length: chapterStepCount }, (_, index) => (
            <span key={index} className={index < chapterStepNumber ? "on" : ""} />
          ))}
        </div>
        <h2 id="tutorial-title" className="tutorial-title">
          {step.title}
        </h2>
        <div id="tutorial-body" className="tutorial-body">
          {step.body.map((paragraph) => (
            <p key={paragraph}>{paragraph}</p>
          ))}
        </div>
        {hint && <div className="tutorial-hint">{hint}</div>}
        <div className="tutorial-actions">
          {!isLast && (
            <button type="button" className="tutorial-skip" onClick={onSkip}>
              Skip tutorial
            </button>
          )}
          <span className="tutorial-actions-spacer" />
          {!isFirst && (
            <button type="button" className="tutorial-btn-secondary" onClick={onBack}>
              Back
            </button>
          )}
          <button ref={primaryRef} type="button" className="tutorial-btn-primary" onClick={next}>
            {primaryLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
