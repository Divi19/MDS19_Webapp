import numpy as np
import pytest

from app.services.predictor import MclSTExpPredictor


def test_retrieval_preserves_cosine_selection_and_inverse_squared_l1_weighting():
    predictor = MclSTExpPredictor("unused.pt", "unused")
    predictor.TOP_K = 2
    predictor.spot_key = np.array(
        [[1.0, 0.0], [2.0, 0.0], [-1.0, 0.0]],
        dtype=np.float32,
    )
    predictor.spot_key_n = predictor.spot_key / np.linalg.norm(
        predictor.spot_key, axis=1, keepdims=True
    )
    predictor.expr_key = np.array(
        [[10.0, 20.0], [30.0, 40.0], [100.0, 100.0]],
        dtype=np.float32,
    )
    prediction, support = predictor._retrieve(
        np.array([[0.5, 0.0]], dtype=np.float32)
    )
    expected_weights = np.array([4.0, 4.0 / 9.0])
    expected_weights /= expected_weights.sum()
    expected_prediction = np.average(
        predictor.expr_key[:2], axis=0, weights=expected_weights
    )
    assert MclSTExpPredictor.TOP_K == 200
    assert prediction[0] == pytest.approx(expected_prediction)
    assert support[0]["max_selected_cosine_similarity"] == pytest.approx(1.0)
    assert support[0]["mean_selected_cosine_similarity"] == pytest.approx(1.0)
    assert support[0]["effective_neighbor_count"] == pytest.approx(
        1.0 / np.sum(expected_weights ** 2)
    )
    assert support[0]["aggregate_neighbor_expression_dispersion"] == pytest.approx(36.0)
