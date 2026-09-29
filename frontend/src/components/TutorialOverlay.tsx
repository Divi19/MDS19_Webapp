"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
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
const ARROW_SIZE = 40;
// How far the pulsing ring grows beyond the spotlight on each side.
const RING_GROWTH = 8;

/** All elements marked for a step. A step can highlight several at once
 * (e.g. the first few history entries); the spotlight covers them all. */
function findTargets(target: string | undefined): HTMLElement[] {
  if (!target) return [];
  return Array.from(document.querySelectorAll<HTMLElement>(`[data-tour="${target}"]`));
}

/** Bounding box of every visible element marked for the step. */
function measureTargets(target: string | undefined): Box | null {
  const rects = findTargets(target)
    .map((element) => element.getBoundingClientRect())
    .filter((rect) => rect.width > 0 && rect.height > 0);
  if (!rects.length) return null;
  const top = Math.min(...rects.map((rect) => rect.top));
  const left = Math.min(...rects.map((rect) => rect.left));
  const bottom = Math.max(...rects.map((rect) => rect.bottom));
  const right = Math.max(...rects.map((rect) => rect.right));
  return { top, left, width: right - left, height: bottom - top };
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

/** Moves an element by transform, optionally without its CSS transition —
 * used when an element first appears, so it doesn't glide in from wherever
 * it was last shown. */
function moveTo(element: HTMLElement, x: number, y: number, instant: boolean) {
  if (instant) element.style.transition = "none";
  element.style.transform = `translate3d(${x}px, ${y}px, 0)`;
  if (instant) {
    void element.offsetWidth;
    element.style.transition = "";
  }
}

function show(element: HTMLElement, visible: boolean) {
  element.style.display = visible ? "block" : "none";
}


// A new step's target must hold still for this many frames before the
// tutorial moves to it — windows, popovers and views often take a frame or
// two to appear and settle.
const SETTLE_FRAMES = 2;
// Longest the tutorial waits for a new step's target before moving anyway.
const SETTLE_TIMEOUT_MS = 600;
// How long a target may briefly disappear (e.g. while being re-created)
// before the spotlight gives up on it.
const MISSING_HOLD_MS = 450;
// Once nothing has moved for this long, the target is re-measured at a
// lower rate instead of every frame.
const IDLE_AFTER_MS = 600;
const IDLE_POLL_MS = 100;

/** Everything the card shows for one step. */
export interface TutorialView {
  step: TutorialStep;
  stepNumber: number;
  stepCount: number;
  chapterStepNumber: number;
  chapterStepCount: number;
  /** Shows a loading indicator in place of Back and Next. */
  waiting?: boolean;
}

function viewKey(view: TutorialView) {
  return `${view.step.id}|${view.stepNumber}|${view.stepCount}|${view.chapterStepNumber}|${view.chapterStepCount}|${view.waiting ? 1 : 0}`;
}

export default function TutorialOverlay({
  view,
  onNext,
  onBack,
  onSkip,
  onTargetActivated,
}: {
  view: TutorialView;
  onNext: () => void;
  onBack: () => void;
  onSkip: () => void;
  /** Called after the user (or Next) clicks the highlighted element on an
   * "advance" step. */
  onTargetActivated: (stepId: string) => void;
}) {
  const cardRef = useRef<HTMLDivElement>(null);
  const primaryRef = useRef<HTMLButtonElement>(null);
  const focusRef = useRef<HTMLDivElement>(null);
  const ringRef = useRef<HTMLDivElement>(null);
  const dimRef = useRef<HTMLDivElement>(null);
  const fullBlockerRef = useRef<HTMLDivElement>(null);
  const blockerRefs = useRef<(HTMLDivElement | null)[]>([]);
  const arrowRef = useRef<HTMLDivElement>(null);
  const arrowInnerRef = useRef<HTMLDivElement>(null);
  const lastLayout = useRef("");
  const lastChangeAt = useRef(0);
  const missingSince = useRef<number | null>(null);
  const cardPlaced = useRef(false);

  // The step on screen lags the requested one until the requested step's
  // target has appeared and settled, so the card's text, the spotlight and
  // the arrow always change together.
  const [shown, setShown] = useState(view);
  const shownRef = useRef(shown);
  const requestedRef = useRef(view);
  // Only used to choose between the action hint and the missing-target
  // note; everything positional is applied to the DOM directly.
  const [targetFound, setTargetFound] = useState(true);

  const { step } = shown;
  const isFirst = shown.stepNumber === 1;
  const isLast = shown.stepNumber === shown.stepCount;

  useLayoutEffect(() => {
    requestedRef.current = view;
  }, [view]);

  useLayoutEffect(() => {
    shownRef.current = shown;
  }, [shown]);

  /** Positions the spotlight, blockers, arrow and card for the current
   * frame. Writes styles directly rather than through React state, so
   * tracking a moving element never re-renders the tutorial. Returns
   * whether anything moved. */
  const applyLayout = useCallback((current: TutorialStep, force: boolean) => {
    const card = cardRef.current;
    const focus = focusRef.current;
    const ring = ringRef.current;
    const dim = dimRef.current;
    const fullBlocker = fullBlockerRef.current;
    const arrow = arrowRef.current;
    const arrowInner = arrowInnerRef.current;
    if (!card || !focus || !ring || !dim || !fullBlocker || !arrow || !arrowInner) return false;

    const box = measureTargets(current.target);
    // A target that vanishes for a moment (a popover being re-created, a
    // window re-rendering) keeps its spotlight rather than snapping away.
    if (!box && current.target && !force && focus.style.display === "block") {
      const now = performance.now();
      missingSince.current ??= now;
      if (now - missingSince.current < MISSING_HOLD_MS) return false;
    }
    if (box) missingSince.current = null;

    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const cardWidth = card.offsetWidth;
    const cardHeight = card.offsetHeight;
    const signature = [
      box ? [box.top, box.left, box.width, box.height].map((value) => value.toFixed(1)).join(",") : "none",
      cardWidth,
      cardHeight,
      vw,
      vh,
      current.id,
    ].join("|");
    if (!force && signature === lastLayout.current) return false;
    lastLayout.current = signature;
    setTargetFound(Boolean(box) || !current.target);

    const hole = box
      ? { top: box.top - PAD, left: box.left - PAD, width: box.width + PAD * 2, height: box.height + PAD * 2 }
      : null;

    // Spotlight, or a plain dim when there is nothing to highlight.
    if (hole) {
      const appearing = focus.style.display !== "block";
      if (appearing) focus.style.transition = "none";
      focus.style.width = `${hole.width}px`;
      focus.style.height = `${hole.height}px`;
      moveTo(focus, hole.left, hole.top, appearing);
      ring.style.setProperty("--ring-sx", String((hole.width + RING_GROWTH * 2) / hole.width));
      ring.style.setProperty("--ring-sy", String((hole.height + RING_GROWTH * 2) / hole.height));
      show(focus, true);
      show(dim, false);
    } else {
      show(focus, false);
      show(dim, true);
    }

    // Click blockers: the whole page, or everything around the highlighted
    // element when the step lets the user interact with it.
    const passThrough = Boolean(hole && current.interaction);
    show(fullBlocker, !passThrough);
    const around = hole
      ? [
          { top: 0, left: 0, width: vw, height: Math.max(0, hole.top) },
          { top: hole.top + hole.height, left: 0, width: vw, height: Math.max(0, vh - hole.top - hole.height) },
          { top: hole.top, left: 0, width: Math.max(0, hole.left), height: hole.height },
          { top: hole.top, left: hole.left + hole.width, width: Math.max(0, vw - hole.left - hole.width), height: hole.height },
        ]
      : [];
    blockerRefs.current.forEach((blocker, index) => {
      if (!blocker) return;
      show(blocker, passThrough);
      const rect = around[index];
      if (passThrough && rect) {
        blocker.style.top = `${rect.top}px`;
        blocker.style.left = `${rect.left}px`;
        blocker.style.width = `${rect.width}px`;
        blocker.style.height = `${rect.height}px`;
      }
    });

    // Card beside the element, or centred when there is none.
    const placement = hole ? placeCard(hole, { width: cardWidth, height: cardHeight }, current.placement) : null;
    const cardLeft = placement ? placement.left : Math.max(MARGIN, (vw - cardWidth) / 2);
    const cardTop = placement ? placement.top : Math.max(MARGIN, (vh - cardHeight) / 2);
    moveTo(card, cardLeft, cardTop, !cardPlaced.current);
    cardPlaced.current = true;

    // Arrow in the gap between the card and the element.
    if (placement?.side) {
      const appearing = arrow.style.display !== "block";
      moveTo(arrow, placement.arrowX - ARROW_SIZE / 2, placement.arrowY - ARROW_SIZE / 2, appearing);
      arrowInner.style.transform = `rotate(${ARROW_ROTATION[placement.side]}deg)`;
      show(arrow, true);
    } else {
      show(arrow, false);
    }
    return true;
  }, []);

  // Lay out before the browser paints a newly shown step, so the card is
  // never placed using the previous step's size.
  useLayoutEffect(() => {
    missingSince.current = null;
    applyLayout(shown.step, true);
    lastChangeAt.current = performance.now();
  }, [applyLayout, shown]);

  // One loop for the lifetime of the tutorial: waits for a requested step's
  // target to settle before showing it, then tracks the shown step's target
  // as it moves or resizes.
  useEffect(() => {
    let frame = 0;
    let lastPoll = 0;
    let pending: { key: string; since: number; box: Box | null; stable: number } | null = null;

    const tick = (now: number) => {
      const requested = requestedRef.current;
      const current = shownRef.current;
      const requestedKey = viewKey(requested);

      if (requestedKey !== viewKey(current)) {
        if (requested.step.id === current.step.id) {
          // Same step, different counts (e.g. the step list changed on
          // sign-in): nothing to wait for.
          setShown(requested);
        } else {
          if (!pending || pending.key !== requestedKey) pending = { key: requestedKey, since: now, box: null, stable: 0 };
          const box = measureTargets(requested.step.target);
          if (box && pending.box && Math.abs(box.top - pending.box.top) < 1 && Math.abs(box.left - pending.box.left) < 1 && Math.abs(box.width - pending.box.width) < 1 && Math.abs(box.height - pending.box.height) < 1) {
            pending.stable += 1;
          } else {
            pending.stable = 0;
          }
          pending.box = box;
          const settled = !requested.step.target || pending.stable >= SETTLE_FRAMES;
          if (settled || now - pending.since > SETTLE_TIMEOUT_MS) {
            pending = null;
            setShown(requested);
          }
        }
      } else {
        pending = null;
        const idle = now - lastChangeAt.current > IDLE_AFTER_MS;
        if (!idle || now - lastPoll >= IDLE_POLL_MS) {
          lastPoll = now;
          if (applyLayout(current.step, false)) lastChangeAt.current = now;
        }
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [applyLayout]);

  // Animation frames pause in background tabs; a timer guarantees the
  // requested step is still shown once the settle timeout has passed.
  const requestedKey = viewKey(view);
  useEffect(() => {
    const timer = window.setTimeout(() => {
      if (viewKey(requestedRef.current) === requestedKey && viewKey(shownRef.current) !== requestedKey) {
        setShown(requestedRef.current);
      }
    }, SETTLE_TIMEOUT_MS + 50);
    return () => window.clearTimeout(timer);
  }, [requestedKey]);

  // Scroll the highlighted element into view once per step.
  useEffect(() => {
    const [element] = findTargets(step.target);
    element?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [step.id, step.target]);

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
      } else if (event.key === "ArrowLeft" && !isFirst && !shown.waiting) {
        event.preventDefault();
        onBack();
      }
    }
    window.addEventListener("keydown", handleKey, true);
    return () => window.removeEventListener("keydown", handleKey, true);
  }, [isFirst, onBack, onSkip, shown.waiting]);

  const hint = step.target && !targetFound ? step.missingTargetNote : step.actionHint;
  const primaryLabel = isFirst ? "Begin tutorial" : isLast ? "Finish tutorial" : "Next";

  return (
    <div
      className="tutorial-layer"
      // Keeps page-level "click outside" handlers (menus, the gene popover)
      // from reacting to clicks on the tutorial itself.
      onMouseDown={(event) => event.stopPropagation()}
    >
      <div ref={dimRef} className="tutorial-dim" />
      <div ref={focusRef} className="tutorial-focus">
        <div className="tutorial-spotlight" />
        <div ref={ringRef} className="tutorial-ring" />
      </div>

      <div ref={fullBlockerRef} className="tutorial-blocker tutorial-blocker-full" />
      {[0, 1, 2, 3].map((index) => (
        <div
          key={index}
          ref={(element) => {
            blockerRefs.current[index] = element;
          }}
          className="tutorial-blocker"
        />
      ))}

      <div ref={arrowRef} className="tutorial-arrow" aria-hidden="true">
        <div ref={arrowInnerRef} className="tutorial-arrow-rotate">
          <svg viewBox="0 0 32 32" fill="none">
            <path d="M16 3 L29 17 H20.5 V29 H11.5 V17 H3 Z" fill="currentColor" stroke="#fff" strokeWidth="1.6" strokeLinejoin="round" />
          </svg>
        </div>
      </div>

      <div
        ref={cardRef}
        className="tutorial-card"
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
            {shown.stepNumber} / {shown.stepCount}
          </span>
        </div>
        <div className="tutorial-progress" aria-hidden="true">
          {Array.from({ length: shown.chapterStepCount }, (_, index) => (
            <span key={index} className={index < shown.chapterStepNumber ? "on" : ""} />
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
        {shown.waiting && (
          <div className="tutorial-loading" role="status">
            <span className="tutorial-spinner" aria-hidden="true" />
            Loading…
          </div>
        )}
        <div className="tutorial-actions">
          {!isLast && (
            <button type="button" className="tutorial-skip" onClick={onSkip}>
              Skip tutorial
            </button>
          )}
          <span className="tutorial-actions-spacer" />
          {!isFirst && !shown.waiting && (
            <button type="button" className="tutorial-btn-secondary" onClick={onBack}>
              Back
            </button>
          )}
          {!shown.waiting && (
            <button ref={primaryRef} type="button" className="tutorial-btn-primary" onClick={next}>
              {primaryLabel}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
