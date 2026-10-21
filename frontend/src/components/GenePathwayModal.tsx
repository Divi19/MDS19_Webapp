"use client";

import { useEffect, useState } from "react";
import { fetchGeneInfo, type GeneInfo } from "@/lib/geneInfo";
import { fetchPathways, type PathwayResult } from "@/lib/pathways";
import PathwayListModal from "./PathwayListModal";

type Lookup<T> = { status: "loading" } | { status: "error" } | { status: "done"; data: T };

/** One gene on its own: its description (MyGene.info) above the pathways
 * (Enrichr) it takes part in. The pathway list is a single-gene Enrichr
 * lookup, so it ranks the terms most specific to this gene first rather than
 * testing a gene set for enrichment. */
export default function GenePathwayModal({
  gene,
  mapLabel,
  onShowOnMap,
  onClose,
}: {
  gene: string;
  /** Button text, e.g. "Go to Genes tab". */
  mapLabel: string;
  /** Closes the table and maps this gene; omitted if the gene has no map data. */
  onShowOnMap?: () => void;
  onClose: () => void;
}) {
  const [info, setInfo] = useState<Lookup<GeneInfo | null>>({ status: "loading" });
  const [paths, setPaths] = useState<Lookup<PathwayResult[]>>({ status: "loading" });

  useEffect(() => {
    let alive = true;
    fetchGeneInfo(gene).then((data) => alive && setInfo({ status: "done", data }));
    fetchPathways([gene])
      .then((data) => alive && setPaths({ status: "done", data }))
      .catch(() => alive && setPaths({ status: "error" }));
    return () => {
      alive = false;
    };
  }, [gene]);

  const detail = info.status === "done" ? info.data : null;
  const intro = (
    <div className="pathway-intro">
      <div className="pathway-intro-name">
        {detail?.name && detail.name.toUpperCase() !== gene.toUpperCase() ? detail.name : gene}
      </div>
      <div className="pathway-intro-text">
        {info.status === "loading"
          ? "Looking up description…"
          : detail?.summary ?? "No description found for this gene."}
      </div>
      <div className="pathway-intro-src">Description via mygene.info</div>
    </div>
  );

  return (
    <PathwayListModal
      pretitle={`${gene} · Enrichr`}
      title="Gene pathways"
      intro={intro}
      status={paths.status}
      results={paths.status === "done" ? paths.data : []}
      emptyText={`No pathways found for ${gene}. It may be an older symbol that the pathway libraries don't recognise.`}
      footer="Pathways this gene takes part in (KEGG, Reactome, GO:BP), most specific to this gene first. Click a row for its description."
      action={onShowOnMap ? { label: mapLabel, onClick: onShowOnMap } : undefined}
      onClose={onClose}
    />
  );
}
