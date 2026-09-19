import pytest

from app.services.analysis import ROIAnalysisError, analyze_roi


def _tiles():
    return [
        {
            "spot_index": index,
            "tile_index": index,
            "x": float(index % 4),
            "y": float(index // 4),
            "expression": {"A": float(10 if index % 2 == 0 else 1), "B": float(index)},
        }
        for index in range(12)
    ]


def test_roi_statistics_are_deterministic_and_exploratory():
    first = analyze_roi(_tiles(), [0, 2, 4, 6, 8, 10], [1, 3, 5, 7, 9, 11], permutations=29, seed=4)
    second = analyze_roi(_tiles(), [0, 2, 4, 6, 8, 10], [1, 3, 5, 7, 9, 11], permutations=29, seed=4)
    assert first == second
    assert first["label"] == "exploratory comparison of predicted spatially autocorrelated tiles"
    assert first["group_a_size"] == first["group_b_size"] == 6
    assert first["permutation_method"] == "within_spatial_block_label_permutation"
    gene = {item["gene_name"]: item for item in first["genes"]}["A"]
    assert gene["group_a_mean"] == 10
    assert gene["group_b_mean"] == 1
    assert gene["effect_size"] > 0
    assert gene["q_value"] >= gene["permutation_p_value"]


@pytest.mark.parametrize(
    ("group_a", "group_b", "tiles", "code"),
    [
        ([0, 1], [1, 2], _tiles(), "ROI_GROUPS_OVERLAP"),
        ([0, 100], [1, 3], _tiles(), "ROI_TILE_NOT_FOUND"),
        ([0], [1, 3], _tiles(), "ROI_GROUP_TOO_SMALL"),
        ([0, 2], [1, 3], [_tiles()[0], {**_tiles()[1], "expression": {"C": 1.0}}], "ROI_INCOMPATIBLE_TILES"),
    ],
)
def test_roi_validation_errors_are_stable(group_a, group_b, tiles, code):
    with pytest.raises(ROIAnalysisError, match=code) as caught:
        analyze_roi(tiles, group_a, group_b, permutations=9)
    assert caught.value.code == code
