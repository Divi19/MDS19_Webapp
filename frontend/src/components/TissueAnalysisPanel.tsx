"use client";

import { useMemo, useState } from "react";
import type { Prediction } from "@/lib/mockPrediction";
import { CL } from "@/lib/mockPrediction";
import {
  clusterTissueLabels, comparableTypes, geneByTissue, genesBetweenClusters, genesHigherIn, MIN_TILES, TISSUE_COLORS,
  TISSUE_SHORT_NAMES, typeClusterGroups, type HigherGene, type TissueClass,
} from "@/lib/tissue";

/** A tissue type's tiles within one expression cluster (map highlight). */
export interface TissueGroup {
  cls: TissueClass;
  cluster: number;
}

/**
 * Column 3 on the Tissue tab (Cluster Analysis everywhere else): how the
 * predicted expression differs between tissue types.
 *  - The selected gene's mean predicted expression in each tissue type, with
 *    the spread of its tiles; types with too few tiles are greyed out.
 *  - Genes clearly higher in a chosen tissue type than in all other tiles,
 *    for any type with enough tiles.
 *  - Expression groups within that type: which expression clusters its tiles
 *    fall into, and the genes that differ between the two largest groups
 *    (e.g. tumour tiles in two different clusters).
 * Picking a type here pins it on the map (and pinning a comparable type from
 * the map legend picks it here); hovering a row highlights that type, and
 * hovering a group highlights just that group's tiles.
 */
export default function TissueAnalysisPanel({
  pred,
  gene,
  onPickGene,
  pinned = null,
  onPin,
  onHoverType,
  onHoverGroup,
}: {
  pred: Prediction;
  gene: string;
  onPickGene: (gene: string) => void;
  pinned?: TissueClass | null;
  onPin?: (cls: TissueClass | null) => void;
  onHoverType?: (cls: TissueClass | null) => void;
  onHoverGroup?: (group: TissueGroup | null) => void;
}) {
  const byClass = useMemo(() => geneByTissue(pred, gene), [pred, gene]);
  const types = useMemo(() => comparableTypes(pred), [pred]);
  const [picked, setPicked] = useState<TissueClass>("Cancer");
  // The pinned type wins when it can be compared; otherwise the last pick,
  // falling back to the first comparable type.
  const type = pinned && types.includes(pinned) ? pinned : types.includes(picked) ? picked : types[0];
  const higher = useMemo(() => (type ? genesHigherIn(pred, type, 10) : []), [pred, type]);
  const labels = useMemo(() => clusterTissueLabels(pred), [pred]);
  const groups = useMemo(() => (type ? typeClusterGroups(pred, type) : []), [pred, type]);
  const between = useMemo(
    () => (type && groups.length >= 2 ? genesBetweenClusters(pred, type, groups[0].cluster, groups[1].cluster, 5) : null),
    [pred, type, groups],
  );
  const clusterName = (c: number) => `cluster ${c}${labels[c] ? ` · ${labels[c]!.full}` : ""}`;
  // One scale for every compared type, wide enough for the spread lines.
  const scale = Math.max(0, ...byClass.filter((c) => c.enough).map((c) => Math.max(c.mean ?? 0, c.q3 ?? 0)));
  const pct = (value: number) => `${Math.min(100, (value / scale) * 100)}%`;

  return (
    <div className="col col-3 tissue-analysis">
      <div className="cluster-analysis-header">
        <div className="cluster-analysis-title">Tissue Analysis</div>
        <div className="cluster-analysis-sub">
          {pred.tissue?.version} · {pred.total} tiles · predicted expression by tissue type
        </div>
      </div>
      <div className="cluster-analysis-list">
        <section className="cluster-analysis-box" aria-labelledby="ta-gene">
          <h4 id="ta-gene" className="ta-title">
            <span className="insight-gene">{gene}</span> by tissue type
          </h4>
          <p className="cluster-analysis-text">
            Bar: mean predicted expression per tile. Line: where the middle half of that type&apos;s tiles fall. A
            difference smaller than the lines is within normal tile-to-tile variation. Types with fewer than{" "}
            {MIN_TILES} tiles are greyed out.
          </p>
          {byClass.map(({ cls, count, mean, q1, q3, enough }) => (
            <div
              key={cls}
              className={`ta-row${enough ? "" : " few"}${pinned === cls ? " pinned" : ""}`}
              onMouseEnter={() => onHoverType?.(cls)}
              onMouseLeave={() => onHoverType?.(null)}
              title={
                enough
                  ? `${cls}: ${count} tiles · mean ${mean!.toFixed(2)} · middle half ${q1!.toFixed(2)}–${q3!.toFixed(2)}`
                  : `${cls}: ${count} tiles · too few to compare`
              }
            >
              <span className="insight-name">
                <span className="dot" style={{ background: TISSUE_COLORS[cls] }} />
                {TISSUE_SHORT_NAMES[cls]}
              </span>
              <span className="ta-bar">
                {enough && scale > 0 && (
                  <>
                    <span className="ta-fill" style={{ width: pct(mean!), background: TISSUE_COLORS[cls] }} />
                    <span className="ta-range" style={{ left: pct(q1!), width: `calc(${pct(q3!)} - ${pct(q1!)})` }} />
                  </>
                )}
              </span>
              <span className="insight-val">{enough ? mean!.toFixed(2) : "too few"}</span>
              <span className="insight-n">n={count}</span>
            </div>
          ))}
        </section>

        <section className="cluster-analysis-box" aria-labelledby="ta-markers">
          <h4 id="ta-markers" className="ta-title">Genes higher in {type ? TISSUE_SHORT_NAMES[type] : "a tissue type"}</h4>
          {types.length ? (
            <>
              <div className="ta-types" role="group" aria-label="Tissue type">
                {types.map((cls) => (
                  <button
                    key={cls}
                    type="button"
                    className={`legend-item legend-compact${cls === type ? " on" : ""}`}
                    aria-pressed={cls === type}
                    title={pinned === cls ? "Pinned on the map · click to unpin" : "Show and pin on the map"}
                    onClick={() => {
                      setPicked(cls);
                      onPin?.(pinned === cls ? null : cls);
                    }}
                  >
                    <span className="legend-dot" style={{ background: TISSUE_COLORS[cls] }} />
                    {TISSUE_SHORT_NAMES[cls]}
                  </button>
                ))}
              </div>
              <p className="cluster-analysis-text">
                Mean in {TISSUE_SHORT_NAMES[type!]} tiles vs all other tiles. Only genes whose difference is at least the
                normal tile-to-tile variation are listed. Click a gene to select it.
              </p>
              {higher.length ? (
                higher.map((row) => (
                  <div key={row.gene} className={`ta-gene-row${row.gene === gene ? " on" : ""}`}>
                    <button type="button" className="insight-gene-btn" onClick={() => onPickGene(row.gene)}>
                      {row.gene}
                    </button>
                    <span className="insight-val">
                      {row.typeMean.toFixed(2)} vs {row.restMean.toFixed(2)}
                    </span>
                    <span className="insight-diff">+{row.diff.toFixed(2)}</span>
                  </div>
                ))
              ) : (
                <p className="insight-note">
                  No genes clearly higher in {TISSUE_SHORT_NAMES[type!]}: no difference is larger than the normal
                  tile-to-tile variation.
                </p>
              )}
            </>
          ) : (
            <p className="insight-note">
              Needs a tissue type with at least {MIN_TILES} tiles and at least {MIN_TILES} other tiles to compare.
            </p>
          )}
        </section>
        {type && (
          <section className="cluster-analysis-box" aria-labelledby="ta-groups">
            <h4 id="ta-groups" className="ta-title">Expression groups within {TISSUE_SHORT_NAMES[type]}</h4>
            <p className="cluster-analysis-text">
              The expression clusters (Clusters tab) that {TISSUE_SHORT_NAMES[type]} tiles fall into. Same tissue type,
              different gene pattern. Hover a group to see its tiles on the map.
            </p>
            {groups.map((g) => (
              <div
                key={g.cluster}
                className="ta-group-row"
                onMouseEnter={() => onHoverGroup?.({ cls: type, cluster: g.cluster })}
                onMouseLeave={() => onHoverGroup?.(null)}
                title={`${g.count} ${type} tiles in ${clusterName(g.cluster)}`}
              >
                <span className="insight-name">
                  <span className="dot" style={{ background: CL[g.cluster] }} />
                  {clusterName(g.cluster)}
                </span>
                <span className="insight-n">n={g.count}</span>
              </div>
            ))}
            {groups.length === 0 && (
              <p className="insight-note">
                {TISSUE_SHORT_NAMES[type]} tiles are spread over clusters with fewer than {MIN_TILES} tiles each.
              </p>
            )}
            {groups.length === 1 && (
              <p className="insight-note">
                Only one cluster has {MIN_TILES} or more {TISSUE_SHORT_NAMES[type]} tiles, so there is no second group to
                compare.
              </p>
            )}
            {between && (
              <div className="ta-between">
                <GroupGenes
                  title={`Higher in cluster ${groups[0].cluster} than cluster ${groups[1].cluster}`}
                  genes={between.higherInA}
                  gene={gene}
                  onPickGene={onPickGene}
                />
                <GroupGenes
                  title={`Higher in cluster ${groups[1].cluster} than cluster ${groups[0].cluster}`}
                  genes={between.higherInB}
                  gene={gene}
                  onPickGene={onPickGene}
                />
              </div>
            )}
          </section>
        )}
      </div>
    </div>
  );
}

/** One side of a two-group comparison: "gene  a vs b  +diff" rows. */
function GroupGenes({
  title,
  genes,
  gene,
  onPickGene,
}: {
  title: string;
  genes: HigherGene[];
  gene: string;
  onPickGene: (gene: string) => void;
}) {
  return (
    <div>
      <div className="cluster-analysis-label">{title}</div>
      {genes.length ? (
        genes.map((row) => (
          <div key={row.gene} className={`ta-gene-row${row.gene === gene ? " on" : ""}`}>
            <button type="button" className="insight-gene-btn" onClick={() => onPickGene(row.gene)}>
              {row.gene}
            </button>
            <span className="insight-val">
              {row.typeMean.toFixed(2)} vs {row.restMean.toFixed(2)}
            </span>
            <span className="insight-diff">+{row.diff.toFixed(2)}</span>
          </div>
        ))
      ) : (
        <p className="insight-note">No genes clearly higher.</p>
      )}
    </div>
  );
}
