
"""MDS19 tissue classifier: numpy-only inference.

Inputs per slide (all spots of one section at once):
  native   (n, 1536)  H0-mini CLS + patch-mean of the 224 crop       (same features v7 uses)
  wide672  (n, 1536)  H0-mini CLS + patch-mean of the 672 crop -> 224 (same features v7 uses)
  coords   (n, 2)     spot GRID coordinates (array units, not pixels)
  pred_expr (n, 785)  retrieval-half prediction of the live hybrid (v7 recipe), BEFORE blending and smoothing
                      -- only needed if stage_config says expr=true
Output: probabilities over stage_config["classes"], smoothed over grid neighbours.
"""
import json, os
import numpy as np


def load(stage_dir):
    cfg = json.load(open(os.path.join(stage_dir, "stage_config.json")))
    z = np.load(os.path.join(stage_dir, "tissue_clf.npz"))
    return {"cfg": cfg, "w": {k: z[k] for k in z.files}}


def neighbour_matrix(coords, radius=1.5):
    xy = np.asarray(coords, dtype=np.float64)
    d = np.sqrt(((xy[:, None, :] - xy[None, :, :]) ** 2).sum(-1))
    W = ((d > 0) & (d <= radius)).astype(np.float64)
    s = W.sum(1, keepdims=True)
    return W / np.where(s == 0, 1.0, s), s[:, 0] > 0


def zscore(E):
    E = np.asarray(E, dtype=np.float64)
    sd = E.std(0)
    sd[sd < 1e-8] = 1.0
    return (E - E.mean(0)) / sd


def nbr_mean(W, has, X):
    return np.where(has[:, None], W @ X, X)


def smooth(P, W, has, alpha):
    if alpha <= 0:
        return P
    return np.where(has[:, None], (1.0 - alpha) * P + alpha * (W @ P), P)


def softmax(L):
    L = L - L.max(1, keepdims=True)
    E = np.exp(L)
    return E / E.sum(1, keepdims=True)


def head_logits(cfg, w, F):
    if cfg["head"] == "lr":
        return F @ w["coef"].T + w["intercept"]
    h = np.maximum(F @ w["W0"] + w["b0"], 0.0)
    return h @ w["W1"] + w["b1"]


def predict_tissue(model, native, wide672, coords, pred_expr=None):
    cfg, w = model["cfg"], model["w"]
    native = np.asarray(native, dtype=np.float64)
    img = native if cfg["img"] == "nat" else np.hstack([native, np.asarray(wide672, dtype=np.float64)])
    # The neighbour matrix is (n, n): built only when a stage actually uses it
    # (neighbour features or smoothing), so large slides stay O(n) in memory.
    if cfg["nbr"] or cfg["alpha"] > 0:
        W, has = neighbour_matrix(coords, cfg["radius"])
    else:
        W, has = None, None
    blocks = {"img": img}
    if cfg["nbr"]:
        blocks["nbr"] = nbr_mean(W, has, img)
    if cfg["expr"]:
        if pred_expr is None:
            raise ValueError("this stage needs v7 predicted expression (n, 785)")
        blocks["expr"] = zscore(pred_expr)
    F = np.hstack([blocks[k] @ w["A_" + k] + w["c_" + k] for k in cfg["blocks"]])
    logits = head_logits(cfg, w, F)
    P = np.zeros((len(F), len(cfg["classes"])))
    P[:, w["cls_idx"]] = softmax(logits)
    P = smooth(P, W, has, cfg["alpha"])
    return {"probs": P, "labels": [cfg["classes"][i] for i in P.argmax(1)], "logits": logits,
            "logit_classes": [cfg["classes"][i] for i in w["cls_idx"]]}
