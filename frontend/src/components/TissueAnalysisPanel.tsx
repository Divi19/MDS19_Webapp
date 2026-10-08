"use client";

import { useMemo, useState } from "react";
import TissueComposition from "./TissueComposition";
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
 * Column 3 on the Tissue tab (Cluster Analysis everywhere else), in two
 * tabs. Expression (default): how the predicted expression differs between
 * tissue types. Composition: the tissue types of each expression cluster
 * (TissueComposition).
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
  onHoverCluster,
  pinnedCluster = null,
  onPinCluster,
}: {
  pred: Prediction;
  gene: string;
  onPickGene: (gene: string) => void;
  pinned?: TissueClass | null;
  onPin?: (cls: TissueClass | null) => void;
  onHoverType?: (cls: TissueClass | null) => void;
  onHoverGroup?: (group: TissueGroup | null) => void;
  onHoverCluster?: (cluster: number | null) => void;
  /** Composition tab: the cluster locked on the map (click a cluster card). */
  pinnedCluster?: number | null;
  onPinCluster?: (cluster: number | null) => void;
}) {
  const [tab, setTab] = useState<"expression" | "composition">("expression");
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
      <div className="cluster-analysis-header ta-header">
        <div>
          <div className="cluster-analysis-title">Tissue Analysis</div>
          <div className="cluster-analysis-sub">
            {pred.total} tiles · {tab === "expression" ? "expression by tissue type" : "tissue types per cluster"}
          </div>
        </div>
        <div className="seg" role="tablist" aria-label="Tissue Analysis view">
          {(["expression", "composition"] as const).map((t) => (
            <button
              key={t}
              type="button"
              role="tab"
              aria-selected={tab === t}
              className={tab === t ? "on" : ""}
              onClick={() => {
                // The rows that set these unmount with the tab, so their
                // mouse-leave never fires.
                onHoverType?.(null);
                onHoverGroup?.(null);
                onHoverCluster?.(null);
                // A cluster lock is only shown (and undone) on the Composition
                // tab, so leaving the tab releases it.
                if (t !== "composition") onPinCluster?.(null);
                setTab(t);
              }}
            >
              {t === "expression" ? "Expression" : "Composition"}
            </button>
          ))}
        </div>
      </div>
      <div className="cluster-analysis-list" role="tabpanel">
        {tab === "composition" ? (
          <TissueComposition
            pred={pred}
            onHoverCluster={onHoverCluster}
            pinnedCluster={pinnedCluster}
            onPinCluster={onPinCluster}
          />
        ) : (
          <>
            <section className="cluster-analysis-box" aria-labelledby="ta-gene">
              <h4 id="ta-gene" className="ta-title">
                <span className="insight-gene">{gene}</span> by tissue type
              </h4>
              <p className="cluster-analysis-text">
                Bar: mean predicted expression per tile. Line: where the middle half of that type&apos;s tiles fall. A
                difference smaller than the lines is within normal tile-to-tile variation. Types with fewer than{" "}
                {MIN_TILES} tiles are greyed out. Click a type to lock it on the map.
              </p>
              {byClass.map(({ cls, count, mean, q1, q3, enough }) => (
                <div
                  key={cls}
                  role="button"
                  tabIndex={0}
                  aria-pressed={pinned === cls}
                  className={`ta-row clickable${enough ? "" : " few"}${pinned === cls ? " pinned" : ""}${
                    pinned && pinned !== cls ? " dimmed" : ""
                  }`}
                  onMouseEnter={() => onHoverType?.(cls)}
                  onMouseLeave={() => onHoverType?.(null)}
                  onClick={() => onPin?.(pinned === cls ? null : cls)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      onPin?.(pinned === cls ? null : cls);
                    }
                  }}
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
                    Average score in {TISSUE_SHORT_NAMES[type!]} tiles and in all other tiles. Only genes that stay clearly
                    higher after allowing for normal tile-to-tile variation and for each tile&apos;s overall level are listed.
                    Click a row to select the gene.
                  </p>
                  {higher.length ? (
                    <GeneCompareTable
                      genes={higher}
                      aLabel={TISSUE_SHORT_NAMES[type!]}
                      bLabel="Other tiles"
                      color={TISSUE_COLORS[type!]}
                      gene={gene}
                      onPickGene={onPickGene}
                    />
                  ) : (
                    <p className="insight-note">
                      No genes clearly higher in {TISSUE_SHORT_NAMES[type!]}.
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
                    <span className="insight-n">{g.count} tiles</span>
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
                    {[
                      { a: groups[0].cluster, b: groups[1].cluster, genes: between.higherInA },
                      { a: groups[1].cluster, b: groups[0].cluster, genes: between.higherInB },
                    ].map(({ a, b, genes }) => (
                      <div key={a}>
                        <div className="cluster-analysis-label">Higher in cluster {a}</div>
                        {genes.length ? (
                          <GeneCompareTable
                            genes={genes}
                            aLabel={`Cluster ${a}`}
                            bLabel={`Cluster ${b}`}
                            color={CL[a]}
                            gene={gene}
                            onPickGene={onPickGene}
                          />
                        ) : (
                          <p className="insight-note">No genes clearly higher in cluster {a}.</p>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </section>
            )}
          </>
        )}
      </div>
    </div>
  );
}

/**
 * A two-group gene comparison as a table, styled like the Predicted Gene
 * Expression table: GENE | <group a> | <group b> | DIFF. | bar. The columns
 * name the groups, so "1.79 vs 0.22" needs no explaining. The bar shows each
 * gene's difference relative to the largest in the table, in the group's
 * colour. Click a row to select the gene.
 */
function GeneCompareTable({
  genes,
  aLabel,
  bLabel,
  color,
  gene,
  onPickGene,
}: {
  genes: HigherGene[];
  aLabel: string;
  bLabel: string;
  color: string;
  gene: string;
  onPickGene: (gene: string) => void;
}) {
  const maxDiff = Math.max(...genes.map((g) => g.diff));
  return (
    <div className="ta-table" role="table" aria-label={`Genes higher in ${aLabel} than ${bLabel}`}>
      <div className="ta-table-head" role="row">
        <span role="columnheader">Gene</span>
        <span role="columnheader" title={`Average score in ${aLabel} tiles`}>
          {aLabel}
        </span>
        <span role="columnheader" title={`Average score in ${bLabel.toLowerCase()} tiles`}>
          {bLabel}
        </span>
        <span role="columnheader" title={`${aLabel} minus ${bLabel.toLowerCase()}`}>
          Diff.
        </span>
        <span aria-hidden />
      </div>
      {genes.map((row) => (
        <button
          key={row.gene}
          type="button"
          role="row"
          aria-label={row.gene}
          className={`ta-table-row${row.gene === gene ? " on" : ""}`}
          title={`${row.gene}: ${row.typeMean.toFixed(2)} in ${aLabel} vs ${row.restMean.toFixed(2)} in ${bLabel.toLowerCase()} (+${row.diff.toFixed(2)}). Click to select.`}
          onClick={() => onPickGene(row.gene)}
        >
          <span className="gene-name">{row.gene}</span>
          <span className="ta-num">{row.typeMean.toFixed(2)}</span>
          <span className="ta-num">{row.restMean.toFixed(2)}</span>
          <span className="ta-num ta-diff">+{row.diff.toFixed(2)}</span>
          <span className="bar-track">
            <span className="bar-fill" style={{ width: `${(row.diff / maxDiff) * 100}%`, background: color }} />
          </span>
        </button>
      ))}
    </div>
  );
}
