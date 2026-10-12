"""
Multi-cancer request pipeline for the Modal inference app (no torch / modal imports,
so it can be tested on a CPU with a fake encoder and a fake MultiCancer).

    slide -> 200 um features -> route -> pick model -> (100 um features if the model needs them) -> predict

What it relies on from Divi's multicancer_inference.MultiCancer (from MDS19_Deploy_D2 brief):
    mc.route(h0, w672)  -> {code, label, prob, probs, distance, supported, reason, model, grid_unit_um}
    mc.reg["route"]     -> {router class code: model key}
    mc.model(key)       -> core with .unit (grid spacing in um), .genes, .cfg, .predict(h0, w672, grid)
    core.cfg            -> model_version, units, limited_support, label  (all read with .get, so a missing key is not fatal)

Tiling:
    Crops never change: 224 px centre crop (154 um) and 672 px context crop resized to 224.
    Only the spacing between tile centres changes with the model's grid unit:
        200 um -> 290 px stride   (HER2ST breast model, exactly as before)
        100 um -> 145 px stride   (HEST models)
    Every 200 um tile is also a 100 um tile (same origin, since 290 = 2 * 145), so features
    computed for the first pass are reused and only the new tiles go through H0-mini.
"""
from __future__ import annotations

import logging
from dataclasses import dataclass

import numpy as np
from PIL import Image

logger = logging.getLogger(__name__)

PATCH = 224                              # spot crop (154 um at ~0.69 um/px)
CONTEXT_MULTIPLIER = 3                   # 672 px context crop, resized to PATCH
STRIDE_BY_UNIT = {200: 290, 100: 145}    # grid unit (um) -> tile-centre spacing (px)
COARSE_UNIT = 200                        # the router always sees this grid
BREAST_CODES = {"IDC"}                   # tissue-v1 was trained on breast: only run it there
TOP_GENES = 50


# ----------------------------------------------------------------------------- tiling
def grid_coords(w: int, h: int, patch: int, stride: int) -> list[tuple[int, int]]:
    """Integer (column, row) indices of every full tile, row-major (same order as the
    original tile_image)."""
    nx = len(range(0, w - patch + 1, stride))
    ny = len(range(0, h - patch + 1, stride))
    return [(ix, iy) for iy in range(ny) for ix in range(nx)]


def tissue_bitmap(pil_image: Image.Image, sat_thresh: float = 0.18, downsample: int = 8) -> np.ndarray:
    """Boolean tissue map (HSV saturation of a downsampled image). Computed once per slide."""
    w, h = pil_image.size
    small = pil_image.convert("RGB").convert("HSV").resize(
        (max(1, w // downsample), max(1, h // downsample)), Image.BILINEAR)
    return (np.asarray(small)[:, :, 1].astype(np.float32) / 255.0) > sat_thresh


def tile_has_tissue(bitmap: np.ndarray, x: int, y: int, patch: int,
                    min_frac: float = 0.25, downsample: int = 8) -> bool:
    y0, y1 = y // downsample, (y + patch) // downsample
    x0, x1 = x // downsample, (x + patch) // downsample
    block = bitmap[y0:y1, x0:x1]
    return bool(block.size and block.mean() >= min_frac)


def crop_tile(pil_image: Image.Image, ix: int, iy: int, stride: int, patch: int = PATCH) -> Image.Image:
    x, y = ix * stride, iy * stride
    return pil_image.crop((x, y, x + patch, y + patch))


def crop_context(pil_image: Image.Image, ix: int, iy: int, stride: int, patch: int = PATCH,
                 multiplier: int = CONTEXT_MULTIPLIER) -> Image.Image:
    """672 px crop centred on the tile centre, resized to 224 (bicubic)."""
    context_crop = patch * multiplier
    cx, cy = ix * stride + patch / 2, iy * stride + patch / 2
    half = context_crop / 2
    box = tuple(round(v) for v in (cx - half, cy - half, cx + half, cy + half))
    p = pil_image.crop(box)
    if context_crop != patch:
        p = p.resize((patch, patch), Image.BICUBIC)
    return p


@dataclass
class Tiles:
    stride: int
    coords: list[tuple[int, int]]        # integer (column, row) on this grid
    native: np.ndarray                   # (n, 1536) 224 px crop features
    context: np.ndarray                  # (n, 1536) 672 px context features
    reused: int = 0                      # how many tiles came from the feature cache


class FeatureExtractor:
    """H0-mini features for the tissue tiles of one slide on a given stride. Features are cached by
    tile origin in pixels, so a finer grid whose origins include the coarser grid's reuses them."""

    def __init__(self, pil_image: Image.Image, encode):
        self.img = pil_image
        self.encode = encode                         # list[PIL] -> (n, 1536) float32
        self.cache: dict[tuple[int, int], tuple[np.ndarray, np.ndarray]] = {}
        self._bitmap = None

    def tiles(self, stride: int, max_tiles: int) -> Tiles:
        w, h = self.img.size
        coords = grid_coords(w, h, PATCH, stride)
        if not coords:
            raise ValueError(f"Image is {w}x{h}px — too small to tile into {PATCH}x{PATCH} patches")
        if self._bitmap is None:
            self._bitmap = tissue_bitmap(self.img)
        kept = [c for c in coords if tile_has_tissue(self._bitmap, c[0] * stride, c[1] * stride, PATCH)]
        if not kept:
            raise ValueError(f"No tissue detected in any of the {len(coords)} tiles")
        if len(kept) > max_tiles:
            raise ValueError(
                f"Slide requires {len(kept)} tissue patches at this resolution, exceeding the "
                f"{max_tiles}-tile safety guard")

        origins = [(ix * stride, iy * stride) for ix, iy in kept]
        need = [i for i, o in enumerate(origins) if o not in self.cache]
        if need:
            spot = [crop_tile(self.img, *kept[i], stride) for i in need]
            ctx = [crop_context(self.img, *kept[i], stride) for i in need]
            nf, cf = self.encode(spot), self.encode(ctx)
            for j, i in enumerate(need):
                self.cache[origins[i]] = (nf[j], cf[j])
        native = np.stack([self.cache[o][0] for o in origins]).astype(np.float32)
        context = np.stack([self.cache[o][1] for o in origins]).astype(np.float32)
        return Tiles(stride, kept, native, context, reused=len(kept) - len(need))


@dataclass
class Plan:
    """What a request resolves to before any prediction: the router decision, the chosen model and the tiles."""
    fx: "FeatureExtractor"
    route: dict
    code: str | None
    model_key: str | None
    overridden: bool
    core: object | None                  # the model (None when the slide is unsupported)
    stride: int | None                   # px between tile centres on the model's grid
    tiles: "Tiles | None"
    unsupported: dict | None             # the "unsupported" response, when the router refused the slide


# ----------------------------------------------------------------------------- helpers
def _plain(v):
    """numpy scalars / arrays -> JSON-safe python."""
    if isinstance(v, dict):
        return {str(k): _plain(x) for k, x in v.items()}
    if isinstance(v, (list, tuple)):
        return [_plain(x) for x in v]
    if isinstance(v, np.generic):
        return v.item()
    if isinstance(v, np.ndarray):
        return v.tolist()
    return v


def stride_for_unit(unit) -> int:
    u = int(round(float(unit)))
    if u not in STRIDE_BY_UNIT:
        raise ValueError(f"model grid unit {unit} um is not supported (expected one of {sorted(STRIDE_BY_UNIT)})")
    return STRIDE_BY_UNIT[u]


# ----------------------------------------------------------------------------- pipeline
class Pipeline:
    def __init__(self, mc, encode, tissue_clf=None, attach_tissue=None,
                 max_tiles_coarse: int = 4000, max_tiles_fine: int = 6000):
        self.mc = mc
        self.encode = encode
        self.tissue_clf = tissue_clf
        self.attach_tissue = attach_tissue
        self.max_tiles_coarse = max_tiles_coarse
        self.max_tiles_fine = max_tiles_fine

    # -- tissue descriptor returned to the app
    def _tissue_info(self, route: dict, code: str, core, overridden: bool) -> dict:
        info = {
            "code": code,
            "label": (core.cfg.get("label") if core is not None else None) or route.get("label"),
            "prob": float(route["prob"]) if route.get("prob") is not None else None,
            "supported": bool(route.get("supported", True)) or overridden,
            "reason": route.get("reason"),
            "limited_support": bool(core.cfg.get("limited_support", False)) if core is not None else False,
            "overridden": overridden,
        }
        if overridden:
            info["router_code"] = route.get("code")
            info["router_prob"] = info["prob"]
            info["prob"] = None
        if isinstance(route.get("probs"), dict):
            info["probs"] = _plain(route["probs"])
        return _plain(info)

    def _pick_model(self, route: dict, tissue: str | None):
        """-> (code, model_key, overridden). Raises ValueError for an unknown override."""
        table = self.mc.reg["route"]
        if tissue:
            if tissue not in table:
                raise ValueError(f"unknown tissue {tissue!r}, expected one of {sorted(table)}")
            logger.warning("tissue override: %s (router said %s, prob %s)",
                           tissue, route.get("code"), route.get("prob"))
            return tissue, table[tissue], True
        return route["code"], route["model"], False

    def plan(self, pil_image: Image.Image, tissue: str | None = None) -> "Plan":
        """Steps 1-3 of a request: route, pick the model, tile at that model's spacing. Shared by the predict
        service (run) and the Grad-CAM service, so both cut a slide into exactly the same spots in the same
        order and `spot_index` means the same tile in both."""
        fx = FeatureExtractor(pil_image, self.encode)

        # 1. the router sees the 200 um grid (same features the breast model uses)
        coarse = fx.tiles(STRIDE_BY_UNIT[COARSE_UNIT], self.max_tiles_coarse)
        route = _plain(self.mc.route(coarse.native, coarse.context))

        # 2. choose a model; refuse unsupported tissue unless the user overrode the router
        code, model_key, overridden = self._pick_model(route, tissue)
        if not overridden and not route.get("supported", True):
            label = route.get("label") or "this tissue"
            prob = route.get("prob")
            how_sure = f" ({prob:.0%})" if isinstance(prob, (int, float)) else ""
            unsupported = {
                "unsupported": True,
                "message": (route.get("reason") or
                            f"Tissue not supported: the slide looks like {label}{how_sure}, "
                            f"which GeneX has no model for."),
                "tissue": self._tissue_info(route, route.get("code"), None, False),
            }
            return Plan(fx, route, code, model_key, overridden, None, None, None, unsupported)

        # 3. tile at the chosen model's spacing (reuse the 200 um features when it is the same grid)
        core = self.mc.model(model_key)
        stride = stride_for_unit(core.unit)
        tiles = coarse if stride == STRIDE_BY_UNIT[COARSE_UNIT] else fx.tiles(stride, self.max_tiles_fine)
        return Plan(fx, route, code, model_key, overridden, core, stride, tiles, None)

    def run(self, pil_image: Image.Image, tissue: str | None = None) -> dict:
        p = self.plan(pil_image, tissue)
        if p.unsupported is not None:
            return p.unsupported
        route, code, model_key, overridden = p.route, p.code, p.model_key, p.overridden
        core, stride, tiles = p.core, p.stride, p.tiles

        # 4. predict the whole slide in one call
        grid = np.asarray(tiles.coords, dtype=np.int64)
        pred = core.predict(tiles.native, tiles.context, grid)            # (n, G) float32
        genes = list(core.genes)

        spots = [
            {"spot_index": i, "x": float(cx), "y": float(cy),
             "expression": {g: float(v) for g, v in zip(genes, pred[i])}}
            for i, (cx, cy) in enumerate(tiles.coords)
        ]
        mean_expr = pred.mean(axis=0)
        order = np.argsort(-mean_expr)
        top_genes = [
            {"gene_name": genes[g], "mean_expression": float(mean_expr[g]), "rank": r + 1}
            for r, g in enumerate(order[:TOP_GENES])
        ]
        tissue_info = self._tissue_info(route, code, core, overridden)
        result = {
            "spots": spots,
            "top_genes": top_genes,
            "model_version": core.cfg.get("model_version") or f"v16-core-{model_key}",
            "tile_px": PATCH,
            "stride_px": stride,
            "tissue": tissue_info,
            "expression_units": core.cfg.get("units"),
            "limited_support": tissue_info["limited_support"],
        }
        logger.info("multicancer: route=%s -> model=%s unit=%sum spots=%d reused=%d",
                    route.get("code"), model_key, core.unit, len(spots), tiles.reused)

        # 5. tissue-v1 (cancer / connective / adipose ...) was trained on breast only, so it runs only for
        #    breast. For every other cancer the per-spot tissue fields are null.
        if self.attach_tissue is not None:
            clf = self.tissue_clf if code in BREAST_CODES else None
            result = self.attach_tissue(result, clf, lambda: (tiles.native, tiles.context), tiles.coords)
        return result


def compare_to_reference(pred, ref, tol: float, corr_min: float = 0.9999) -> dict:
    """Acceptance check of a model's output against its stored reference output.
    ok = max abs difference < tol AND correlation >= corr_min (a NaN correlation fails)."""
    pred = np.asarray(pred, dtype=np.float64)
    ref = np.asarray(ref, dtype=np.float64)
    if pred.shape != ref.shape:
        return {"ok": False, "error": f"shape {pred.shape} differs from reference {ref.shape}"}
    d = np.abs(pred - ref)
    a, b = pred.ravel(), ref.ravel()
    corr = float(np.corrcoef(a, b)[0, 1]) if a.std() > 0 and b.std() > 0 else float("nan")
    out = {"max_abs_diff": float(d.max()), "mean_abs_diff": float(d.mean()),
           "rel_max": float(d.max() / (ref.std() + 1e-12)), "correlation": corr,
           "tol": tol, "n_spots": int(pred.shape[0])}
    out["ok"] = bool(out["max_abs_diff"] < tol and corr >= corr_min)
    return out
