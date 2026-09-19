import json

import pytest

from app.services.analysis import analyze_prediction_tiles, benjamini_hochberg


def _tiles():
    tiles = []
    for index in range(24):
        x = index % 6
        y = index // 6
        high = x >= 3
        tiles.append({
            "spot_index": index,
            "tile_index": index,
            "x": float(x),
            "y": float(y),
            "expression": {
                "LEFT": 8.0 if not high else 1.0,
                "RIGHT": 1.0 if not high else 9.0,
                "GRADIENT": float(x + y),
                "CONSTANT": 2.0,
            },
        })
    return tiles


def test_benjamini_hochberg_known_values():
    assert benjamini_hochberg([0.01, 0.04, 0.03]) == pytest.approx([0.03, 0.04, 0.04])


def test_moran_and_predicted_expression_domains_are_deterministic():
    first = analyze_prediction_tiles(_tiles(), domain_count=2, permutations=29, seed=7)
    second = analyze_prediction_tiles(_tiles(), domain_count=2, permutations=29, seed=7)
    assert json.dumps(first, sort_keys=True) == json.dumps(second, sort_keys=True)
    statistics = {item["gene_name"]: item for item in first["spatial_statistics"]["genes"]}
    assert statistics["LEFT"]["morans_i"] > 0
    assert 0 < statistics["LEFT"]["empirical_p_value"] <= 1
    assert first["analysis_method"]["result_type"] == "predicted-expression domains"
    assert first["analysis_method"]["kmeans_seed"] == 7
    assert sum(first["embeddings"]["explained_variance_ratio"]) <= 1.0 + 1e-12


def test_ranked_domain_markers_have_positive_domain_vs_rest_signs():
    result = analyze_prediction_tiles(_tiles(), domain_count=2, permutations=9)
    markers = [marker for summary in result["domain_summaries"] for marker in summary["markers"]]
    assert markers
    assert all(marker["effect_size"] > 0 for marker in markers)
    assert all(marker["domain_mean"] > marker["rest_mean"] for marker in markers)


def test_constant_panel_returns_serializable_single_domain():
    tiles = [{"spot_index": index, "tile_index": index, "x": float(index), "y": 0.0, "expression": {"A": 1.0}} for index in range(4)]
    result = analyze_prediction_tiles(tiles, permutations=9)
    assert result["analysis_method"]["kmeans_fitted_k"] == 1
    json.dumps(result, allow_nan=False)
