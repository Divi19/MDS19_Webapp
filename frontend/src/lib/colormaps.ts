export type ColormapName = "viridis" | "magma" | "inferno";

export const COLORMAP_NAMES: ColormapName[] = ["viridis", "magma", "inferno"];

type Rgb = [number, number, number];

// Nine evenly spaced samples of each matplotlib colourmap; perceptually
// uniform and colourblind-safe, so linear interpolation between them is faithful.
const STOPS: Record<ColormapName, Rgb[]> = {
  viridis: [
    [68, 1, 84],
    [71, 44, 122],
    [59, 81, 139],
    [44, 113, 142],
    [33, 144, 141],
    [39, 173, 129],
    [92, 200, 99],
    [170, 220, 50],
    [253, 231, 37],
  ],
  magma: [
    [0, 0, 4],
    [28, 16, 68],
    [79, 18, 123],
    [129, 37, 129],
    [181, 54, 122],
    [229, 80, 100],
    [251, 135, 97],
    [254, 194, 135],
    [252, 253, 191],
  ],
  inferno: [
    [0, 0, 4],
    [31, 12, 72],
    [85, 15, 109],
    [136, 34, 106],
    [186, 54, 85],
    [227, 89, 51],
    [249, 140, 10],
    [249, 201, 50],
    [252, 255, 164],
  ],
};

export function colormap(name: ColormapName, t: number): string {
  const stops = STOPS[name];
  const clamped = t < 0 ? 0 : t > 1 ? 1 : t;
  const f = clamped * (stops.length - 1);
  const i = Math.floor(f);
  const u = f - i;
  const a = stops[i];
  const b = stops[Math.min(stops.length - 1, i + 1)];
  return `rgb(${Math.round(a[0] + (b[0] - a[0]) * u)},${Math.round(a[1] + (b[1] - a[1]) * u)},${Math.round(
    a[2] + (b[2] - a[2]) * u,
  )})`;
}

export function colormapCss(name: ColormapName): string {
  const stops = STOPS[name];
  const parts = stops.map(([r, g, b], i) => `rgb(${r},${g},${b}) ${Math.round((i / (stops.length - 1)) * 100)}%`);
  return `linear-gradient(to right, ${parts.join(", ")})`;
}
