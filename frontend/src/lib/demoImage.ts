/**
 * Synthetic H&E section for the "Load demo section" button — a nucleus-dense
 * carcinoma core fading into looser stroma, drawn on an offscreen canvas.
 */
import { gaussC, inMask, mulberry32 } from "./mockPrediction";

export function makeDemoHE(): string {
  const c = document.createElement("canvas");
  c.width = 320;
  c.height = 240;
  const ctx = c.getContext("2d");
  if (!ctx) return "";

  ctx.fillStyle = "#f7eef2";
  ctx.fillRect(0, 0, 320, 240);

  const X = (x: number) => 16 + x * 288;
  const Y = (y: number) => 12 + y * 216;

  ctx.fillStyle = "rgba(224,168,196,.5)";
  (
    [
      [0.42, 0.55, 0.37, 0.42],
      [0.7, 0.66, 0.24, 0.22],
      [0.4, 0.22, 0.2, 0.17],
    ] as const
  ).forEach((e) => {
    ctx.beginPath();
    ctx.ellipse(X(e[0]), Y(e[1]), e[2] * 288, e[3] * 216, 0, 0, 6.2832);
    ctx.fill();
  });

  const r2 = mulberry32(5);
  for (let i = 0; i < 5200; i++) {
    const x = r2();
    const y = r2();
    if (!inMask(x, y)) continue;
    const cell =
      0.2 + 0.95 * gaussC(x, y, 0.47, 0.34, 0.18) + 0.7 * gaussC(x, y, 0.5, 0.5, 0.24);
    ctx.beginPath();
    if (r2() < cell * 0.8) {
      ctx.fillStyle = "rgba(96,44,120,.8)";
      ctx.arc(X(x), Y(y), 1.3, 0, 6.2832);
    } else {
      ctx.fillStyle = "rgba(210,150,180,.32)";
      ctx.arc(X(x), Y(y), 2, 0, 6.2832);
    }
    ctx.fill();
  }
  return c.toDataURL("image/png");
}
