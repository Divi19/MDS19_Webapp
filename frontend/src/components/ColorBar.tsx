import { colormapCss, type ColormapName } from "@/lib/colormaps";

export default function ColorBar({
  name,
  gene,
  min,
  max,
}: {
  name: ColormapName;
  gene: string;
  min?: number;
  max?: number;
}) {
  const hasRange = typeof min === "number" && typeof max === "number";
  return (
    <figure className="colorbar" aria-label={`${name} colour scale for ${gene}`}>
      <figcaption className="colorbar-title">
        <span className="gene-symbol">{gene}</span>
        <span>{hasRange ? "predicted expression" : "relative expression"}</span>
      </figcaption>
      <div className="colorbar-ramp" style={{ background: colormapCss(name) }} />
      <div className="colorbar-ticks tabular">
        <span>{hasRange ? min!.toFixed(2) : "0.00"}</span>
        <span>{hasRange ? max!.toFixed(2) : "1.00"}</span>
      </div>
    </figure>
  );
}
