from __future__ import annotations

import math
from typing import Any

import numpy as np
from scipy.stats import t as student_t
from sklearn.cluster import KMeans
from sklearn.decomposition import PCA
from sklearn.metrics import silhouette_score
from sklearn.neighbors import NearestNeighbors


DEFAULT_SEED = 19
DEFAULT_PERMUTATIONS = 99
DEFAULT_DOMAIN_COUNT = 5
MAX_VARIABLE_GENES = 100
MAX_MARKERS_PER_DOMAIN = 25


class AnalysisInputError(ValueError):
    pass


class ROIAnalysisError(ValueError):
    def __init__(self, code: str):
        self.code = code
        super().__init__(code)


def benjamini_hochberg(p_values: list[float] | np.ndarray) -> list[float]:
    values = np.asarray(p_values, dtype=float)
    if values.ndim != 1:
        raise ValueError("p-values must be one-dimensional")
    values = np.where(np.isfinite(values), np.clip(values, 0.0, 1.0), 1.0)
    count = values.size
    if count == 0:
        return []
    order = np.argsort(values, kind="mergesort")
    ranked = values[order]
    adjusted = ranked * count / np.arange(1, count + 1)
    adjusted = np.minimum.accumulate(adjusted[::-1])[::-1]
    result = np.empty(count, dtype=float)
    result[order] = np.clip(adjusted, 0.0, 1.0)
    return result.tolist()


def _matrix_from_tiles(tiles: list[dict[str, Any]]) -> tuple[list[str], np.ndarray, np.ndarray, list[int]]:
    if not tiles:
        raise AnalysisInputError("At least one prediction tile is required")
    first_expression = tiles[0].get("expression")
    if not isinstance(first_expression, dict) or not first_expression:
        raise AnalysisInputError("Prediction tiles must contain expression values")
    genes = list(first_expression)
    gene_set = set(genes)
    matrix = np.empty((len(tiles), len(genes)), dtype=np.float64)
    coordinates = np.empty((len(tiles), 2), dtype=np.float64)
    tile_indices = []
    for row, tile in enumerate(tiles):
        expression = tile.get("expression")
        if not isinstance(expression, dict) or set(expression) != gene_set:
            raise AnalysisInputError("Prediction tiles must contain the same gene panel")
        try:
            matrix[row] = [float(expression[gene]) for gene in genes]
            coordinates[row] = [float(tile["x"]), float(tile["y"])]
        except (KeyError, TypeError, ValueError) as exc:
            raise AnalysisInputError("Prediction tiles contain invalid numeric values") from exc
        tile_index = tile.get("tile_index")
        if tile_index is None:
            tile_index = tile.get("spot_index")
        if not isinstance(tile_index, int):
            raise AnalysisInputError("Prediction tiles must have integer tile indices")
        tile_indices.append(tile_index)
    if len(set(tile_indices)) != len(tile_indices):
        raise AnalysisInputError("Prediction tile indices must be unique")
    if not np.all(np.isfinite(matrix)) or not np.all(np.isfinite(coordinates)):
        raise AnalysisInputError("Prediction tiles contain non-finite values")
    return genes, matrix, coordinates, tile_indices


def _neighbor_edges(coordinates: np.ndarray, requested_neighbors: int) -> tuple[np.ndarray, np.ndarray, int]:
    count = coordinates.shape[0]
    if count < 2:
        return np.array([], dtype=int), np.array([], dtype=int), 0
    neighbors = min(max(1, requested_neighbors), count - 1)
    indices = NearestNeighbors(n_neighbors=neighbors, algorithm="brute").fit(coordinates).kneighbors(return_distance=False)
    adjacency = np.zeros((count, count), dtype=bool)
    rows = np.repeat(np.arange(count), neighbors)
    adjacency[rows, indices.reshape(-1)] = True
    adjacency |= adjacency.T
    np.fill_diagonal(adjacency, False)
    source, target = np.nonzero(adjacency)
    return source, target, neighbors


def _morans_statistics(
    matrix: np.ndarray,
    source: np.ndarray,
    target: np.ndarray,
    permutations: int,
    seed: int,
) -> tuple[list[float | None], list[float], list[float]]:
    tile_count, gene_count = matrix.shape
    centered = matrix - matrix.mean(axis=0)
    denominator = np.sum(centered * centered, axis=0)
    valid = denominator > 0
    observed = np.full(gene_count, np.nan, dtype=float)
    if source.size and np.any(valid):
        observed[valid] = tile_count * np.sum(centered[source] * centered[target], axis=0)[valid] / (source.size * denominator[valid])
    p_values = np.ones(gene_count, dtype=float)
    if source.size and tile_count > 2 and permutations > 0 and np.any(valid):
        expected = -1.0 / (tile_count - 1)
        exceedances = np.zeros(gene_count, dtype=int)
        rng = np.random.default_rng(seed)
        observed_distance = np.abs(observed - expected)
        for _ in range(permutations):
            order = rng.permutation(tile_count)
            permuted_numerator = np.sum(centered[order[source]] * centered[order[target]], axis=0)
            permuted = np.full(gene_count, np.nan, dtype=float)
            permuted[valid] = tile_count * permuted_numerator[valid] / (source.size * denominator[valid])
            exceedances[valid] += np.abs(permuted[valid] - expected) >= observed_distance[valid] - 1e-15
        p_values[valid] = (exceedances[valid] + 1.0) / (permutations + 1.0)
    q_values = benjamini_hochberg(p_values)
    values = [float(value) if math.isfinite(value) else None for value in observed]
    return values, p_values.tolist(), q_values


def _canonical_labels(raw_labels: np.ndarray, centers: np.ndarray) -> tuple[np.ndarray, dict[int, str]]:
    ordered = sorted(range(centers.shape[0]), key=lambda index: tuple(float(value) for value in centers[index]))
    mapping = {old: f"domain_{rank + 1}" for rank, old in enumerate(ordered)}
    numeric_mapping = {old: rank for rank, old in enumerate(ordered)}
    canonical = np.array([numeric_mapping[int(label)] for label in raw_labels], dtype=int)
    return canonical, mapping


def _fit_domains(
    matrix: np.ndarray,
    genes: list[str],
    requested_domains: int,
    seed: int,
    max_variable_genes: int,
) -> tuple[np.ndarray, np.ndarray, list[str], list[float], float | None, int, list[str]]:
    warnings = []
    tile_count, gene_count = matrix.shape
    variances = np.var(matrix, axis=0)
    stable_names = np.asarray(genes, dtype=object)
    order = np.lexsort((stable_names, -variances))
    variable_indices = [int(index) for index in order if variances[index] > 0][:min(max_variable_genes, gene_count)]
    if not variable_indices:
        warnings.append("All genes are constant; one predicted-expression domain was returned")
        return np.zeros(tile_count, dtype=int), np.zeros((tile_count, 1), dtype=float), [], [0.0], None, 1, warnings
    variable_genes = [genes[index] for index in variable_indices]
    selected = matrix[:, variable_indices]
    means = selected.mean(axis=0)
    scales = selected.std(axis=0)
    scales[scales == 0] = 1.0
    standardized = (selected - means) / scales
    if tile_count < 2:
        embeddings = np.zeros((tile_count, 1), dtype=float)
        return np.zeros(tile_count, dtype=int), embeddings, variable_genes, [0.0], None, 1, warnings + ["Silhouette is undefined for one tile"]
    component_count = min(10, tile_count - 1, standardized.shape[1])
    pca = PCA(n_components=component_count, svd_solver="full")
    embeddings = pca.fit_transform(standardized)
    explained = [float(value) for value in pca.explained_variance_ratio_]
    unique_count = np.unique(np.round(embeddings, decimals=12), axis=0).shape[0]
    actual_domains = min(max(1, requested_domains), tile_count, unique_count)
    if actual_domains < requested_domains:
        warnings.append(f"Requested {requested_domains} predicted-expression domains; fitted {actual_domains} because of tile or feature limits")
    if actual_domains == 1:
        labels = np.zeros(tile_count, dtype=int)
        silhouette = None
        warnings.append("Silhouette is undefined for one predicted-expression domain")
    else:
        model = KMeans(n_clusters=actual_domains, random_state=seed, n_init=20, algorithm="lloyd")
        raw_labels = model.fit_predict(embeddings)
        labels, _ = _canonical_labels(raw_labels, model.cluster_centers_)
        if actual_domains < tile_count and np.unique(labels).size > 1:
            silhouette = float(silhouette_score(embeddings, labels, metric="euclidean"))
        else:
            silhouette = None
            warnings.append("Silhouette is undefined when every tile forms its own predicted-expression domain")
    return labels, embeddings, variable_genes, explained, silhouette, actual_domains, warnings


def _welch_p_values(group: np.ndarray, rest: np.ndarray) -> np.ndarray:
    gene_count = group.shape[1]
    if group.shape[0] < 2 or rest.shape[0] < 2:
        return np.ones(gene_count, dtype=float)
    mean_difference = group.mean(axis=0) - rest.mean(axis=0)
    group_variance = group.var(axis=0, ddof=1)
    rest_variance = rest.var(axis=0, ddof=1)
    group_term = group_variance / group.shape[0]
    rest_term = rest_variance / rest.shape[0]
    standard_error_squared = group_term + rest_term
    p_values = np.ones(gene_count, dtype=float)
    valid = standard_error_squared > 0
    statistic = np.zeros(gene_count, dtype=float)
    statistic[valid] = mean_difference[valid] / np.sqrt(standard_error_squared[valid])
    denominator = np.zeros(gene_count, dtype=float)
    denominator[valid] = group_term[valid] ** 2 / (group.shape[0] - 1) + rest_term[valid] ** 2 / (rest.shape[0] - 1)
    degrees = np.zeros(gene_count, dtype=float)
    degree_valid = valid & (denominator > 0)
    degrees[degree_valid] = standard_error_squared[degree_valid] ** 2 / denominator[degree_valid]
    p_values[degree_valid] = 2.0 * student_t.sf(np.abs(statistic[degree_valid]), degrees[degree_valid])
    zero_error_difference = (~valid) & (mean_difference != 0)
    p_values[zero_error_difference] = 0.0
    return np.clip(p_values, 0.0, 1.0)


def _domain_summaries(
    matrix: np.ndarray,
    genes: list[str],
    labels: np.ndarray,
    marker_limit: int,
) -> tuple[list[dict[str, Any]], list[str]]:
    summaries = []
    warnings = []
    tile_count = matrix.shape[0]
    for domain_number in range(int(labels.max()) + 1):
        selected = labels == domain_number
        group = matrix[selected]
        rest = matrix[~selected]
        if rest.shape[0] == 0:
            summaries.append({"domain_id": f"domain_{domain_number + 1}", "label": "predicted-expression domain", "tile_count": int(group.shape[0]), "markers": []})
            continue
        group_mean = group.mean(axis=0)
        rest_mean = rest.mean(axis=0)
        group_variance = group.var(axis=0, ddof=1) if group.shape[0] > 1 else np.zeros(matrix.shape[1])
        rest_variance = rest.var(axis=0, ddof=1) if rest.shape[0] > 1 else np.zeros(matrix.shape[1])
        degrees = group.shape[0] + rest.shape[0] - 2
        if degrees > 0:
            pooled_variance = ((group.shape[0] - 1) * group_variance + (rest.shape[0] - 1) * rest_variance) / degrees
        else:
            pooled_variance = np.zeros(matrix.shape[1])
        difference = group_mean - rest_mean
        effects = np.zeros(matrix.shape[1], dtype=float)
        valid_scale = pooled_variance > 0
        effects[valid_scale] = difference[valid_scale] / np.sqrt(pooled_variance[valid_scale])
        effects[(~valid_scale) & (difference > 0)] = np.inf
        effects[(~valid_scale) & (difference < 0)] = -np.inf
        correction = 1.0 - 3.0 / (4.0 * tile_count - 9.0) if tile_count > 2 else 1.0
        effects *= correction
        p_values = _welch_p_values(group, rest)
        q_values = np.asarray(benjamini_hochberg(p_values))
        positive = np.flatnonzero(effects > 0)
        ranked = sorted(positive, key=lambda index: (-effects[index], q_values[index], genes[index]))[:marker_limit]
        markers = []
        for rank, index in enumerate(ranked, start=1):
            effect = effects[index]
            markers.append({
                "gene_name": genes[index],
                "rank": rank,
                "effect_size": float(effect) if math.isfinite(effect) else float(np.sign(effect) * np.finfo(np.float32).max),
                "welch_p_value": float(p_values[index]),
                "q_value": float(q_values[index]),
                "domain_mean": float(group_mean[index]),
                "rest_mean": float(rest_mean[index]),
                "domain_detection_fraction": float(np.mean(group[:, index] > 0)),
                "rest_detection_fraction": float(np.mean(rest[:, index] > 0)),
            })
        summaries.append({"domain_id": f"domain_{domain_number + 1}", "label": "predicted-expression domain", "tile_count": int(group.shape[0]), "markers": markers})
        if group.shape[0] < 2 or rest.shape[0] < 2:
            warnings.append(f"Welch tests for domain_{domain_number + 1} were not defined for undersized groups and use p=1")
    return summaries, warnings


def analyze_roi(
    tiles: list[dict[str, Any]],
    group_a_tile_indices: list[int],
    group_b_tile_indices: list[int],
    genes: list[str] | None = None,
    permutations: int = DEFAULT_PERMUTATIONS,
    seed: int = DEFAULT_SEED,
) -> dict[str, Any]:
    if set(group_a_tile_indices) & set(group_b_tile_indices):
        raise ROIAnalysisError("ROI_GROUPS_OVERLAP")
    if len(group_a_tile_indices) < 2 or len(group_b_tile_indices) < 2:
        raise ROIAnalysisError("ROI_GROUP_TOO_SMALL")
    if len(set(group_a_tile_indices)) != len(group_a_tile_indices) or len(set(group_b_tile_indices)) != len(group_b_tile_indices):
        raise ROIAnalysisError("ROI_INCOMPATIBLE_PAYLOAD")
    if not 1 <= permutations <= 199:
        raise ROIAnalysisError("ROI_INVALID_PERMUTATION_COUNT")
    try:
        all_genes, matrix, coordinates, tile_indices = _matrix_from_tiles(tiles)
    except AnalysisInputError as exc:
        raise ROIAnalysisError("ROI_INCOMPATIBLE_TILES") from exc
    row_by_tile = {tile_index: row for row, tile_index in enumerate(tile_indices)}
    requested = group_a_tile_indices + group_b_tile_indices
    if any(tile_index not in row_by_tile for tile_index in requested):
        raise ROIAnalysisError("ROI_TILE_NOT_FOUND")
    selected_genes = all_genes if genes is None else genes
    if not selected_genes or len(set(selected_genes)) != len(selected_genes) or any(gene not in all_genes for gene in selected_genes):
        raise ROIAnalysisError("ROI_INCOMPATIBLE_GENE_PANEL")
    gene_columns = np.array([all_genes.index(gene) for gene in selected_genes], dtype=int)
    selected_rows = np.array([row_by_tile[index] for index in requested], dtype=int)
    selected_matrix = matrix[selected_rows][:, gene_columns]
    selected_coordinates = coordinates[selected_rows]
    group_a_size = len(group_a_tile_indices)
    labels = np.zeros(len(requested), dtype=bool)
    labels[:group_a_size] = True
    group_a = selected_matrix[labels]
    group_b = selected_matrix[~labels]
    group_a_mean = group_a.mean(axis=0)
    group_b_mean = group_b.mean(axis=0)
    difference = group_a_mean - group_b_mean
    group_a_variance = group_a.var(axis=0, ddof=1)
    group_b_variance = group_b.var(axis=0, ddof=1)
    pooled_variance = ((group_a_size - 1) * group_a_variance + (group_b.shape[0] - 1) * group_b_variance) / (group_a_size + group_b.shape[0] - 2)
    effects = np.zeros(len(selected_genes), dtype=float)
    effect_scale = pooled_variance.copy()
    combined_variance = selected_matrix.var(axis=0, ddof=1)
    effect_scale[effect_scale <= 0] = combined_variance[effect_scale <= 0]
    valid_effect = effect_scale > 0
    effects[valid_effect] = difference[valid_effect] / np.sqrt(effect_scale[valid_effect])
    if selected_coordinates.shape[0] >= 4:
        distances, _ = NearestNeighbors(n_neighbors=2, algorithm="brute").fit(selected_coordinates).kneighbors(selected_coordinates)
        positive_distances = distances[:, 1][distances[:, 1] > 0]
    else:
        positive_distances = np.array([], dtype=float)
    if positive_distances.size:
        width = float(np.median(positive_distances) * 3.0)
        origin = selected_coordinates.min(axis=0)
        block_pairs = np.floor((selected_coordinates - origin) / max(width, np.finfo(float).eps)).astype(int)
        _, block_ids = np.unique(block_pairs, axis=0, return_inverse=True)
        mixed_blocks = [block for block in np.unique(block_ids) if np.any(labels[block_ids == block]) and np.any(~labels[block_ids == block])]
    else:
        block_ids = np.zeros(len(requested), dtype=int)
        mixed_blocks = []
    use_blocks = bool(mixed_blocks)
    rng = np.random.default_rng(seed)
    exceedances = np.zeros(len(selected_genes), dtype=int)
    for _ in range(permutations):
        if use_blocks:
            permuted_labels = labels.copy()
            for block in np.unique(block_ids):
                positions = np.flatnonzero(block_ids == block)
                permuted_labels[positions] = rng.permutation(labels[positions])
        else:
            permuted_labels = rng.permutation(labels)
        permuted_difference = selected_matrix[permuted_labels].mean(axis=0) - selected_matrix[~permuted_labels].mean(axis=0)
        exceedances += np.abs(permuted_difference) >= np.abs(difference) - 1e-15
    p_values = (exceedances + 1.0) / (permutations + 1.0)
    q_values = benjamini_hochberg(p_values)
    comparisons = []
    for index, gene in enumerate(selected_genes):
        comparisons.append({
            "gene_name": gene,
            "group_a_mean": float(group_a_mean[index]),
            "group_b_mean": float(group_b_mean[index]),
            "mean_difference": float(difference[index]),
            "effect_size": float(effects[index]) if math.isfinite(effects[index]) else None,
            "permutation_p_value": float(p_values[index]),
            "q_value": float(q_values[index]),
        })
    warnings = ["This is an exploratory comparison of predicted spatially autocorrelated tiles; neighboring tiles are not independent samples"]
    if not use_blocks:
        warnings.append("Spatial-block permutation was not feasible for these groups; unrestricted label permutation was used")
    return {
        "label": "exploratory comparison of predicted spatially autocorrelated tiles",
        "group_a_size": group_a_size,
        "group_b_size": int(group_b.shape[0]),
        "permutation_method": "within_spatial_block_label_permutation" if use_blocks else "unrestricted_label_permutation",
        "permutations": permutations,
        "seed": seed,
        "genes": comparisons,
        "warnings": warnings,
    }


def analyze_prediction_tiles(
    tiles: list[dict[str, Any]],
    domain_count: int = DEFAULT_DOMAIN_COUNT,
    permutations: int = DEFAULT_PERMUTATIONS,
    seed: int = DEFAULT_SEED,
    neighbor_count: int = 6,
    max_variable_genes: int = MAX_VARIABLE_GENES,
    marker_limit: int = MAX_MARKERS_PER_DOMAIN,
) -> dict[str, Any]:
    if not 1 <= domain_count <= 20:
        raise AnalysisInputError("Domain count must be between 1 and 20")
    if not 0 <= permutations <= 199:
        raise AnalysisInputError("Permutation count must be between 0 and 199")
    genes, matrix, coordinates, tile_indices = _matrix_from_tiles(tiles)
    source, target, actual_neighbors = _neighbor_edges(coordinates, neighbor_count)
    morans_i, p_values, q_values = _morans_statistics(matrix, source, target, permutations, seed)
    means = matrix.mean(axis=0)
    variances = matrix.var(axis=0)
    spatial_genes = [
        {
            "gene_name": gene,
            "mean_expression": float(means[index]),
            "variance_expression": float(variances[index]),
            "morans_i": morans_i[index],
            "empirical_p_value": float(p_values[index]),
            "q_value": float(q_values[index]),
        }
        for index, gene in enumerate(genes)
    ]
    labels, embeddings, variable_genes, explained, silhouette, actual_domains, warnings = _fit_domains(
        matrix, genes, domain_count, seed, max_variable_genes
    )
    domain_summaries, marker_warnings = _domain_summaries(matrix, genes, labels, marker_limit)
    warnings.extend(marker_warnings)
    if source.size == 0:
        warnings.append("Moran's I is undefined because coordinate-derived neighbors could not be formed")
    assignments = [
        {"tile_index": tile_index, "domain_id": f"domain_{int(labels[row]) + 1}", "label": "predicted-expression domain"}
        for row, tile_index in enumerate(tile_indices)
    ]
    embedding_rows = [
        {"tile_index": tile_index, "components": [float(value) for value in embeddings[row]]}
        for row, tile_index in enumerate(tile_indices)
    ]
    return {
        "spatial_statistics": {
            "neighbor_method": "symmetric_coordinate_knn",
            "neighbor_count": actual_neighbors,
            "permutations": permutations,
            "seed": seed,
            "p_value_method": "two_sided_empirical_around_randomization_expectation",
            "multiple_testing_method": "Benjamini-Hochberg",
            "genes": spatial_genes,
        },
        "domain_assignments": assignments,
        "domain_summaries": domain_summaries,
        "embeddings": {
            "method": "PCA",
            "components": int(embeddings.shape[1]),
            "explained_variance_ratio": explained,
            "tiles": embedding_rows,
        },
        "analysis_method": {
            "analysis_version": "spatial-analysis-v1",
            "result_type": "predicted-expression domains",
            "variable_gene_selection": "highest_population_variance",
            "variable_gene_limit": max_variable_genes,
            "variable_genes": variable_genes,
            "standardization": "per_gene_zero_mean_unit_population_variance",
            "pca_solver": "full",
            "kmeans_requested_k": domain_count,
            "kmeans_fitted_k": actual_domains,
            "kmeans_seed": seed,
            "kmeans_n_init": 20,
            "kmeans_algorithm": "lloyd",
            "marker_effect_size": "bias_corrected_standardized_mean_difference_domain_vs_rest",
            "marker_test": "two_sided_Welch_t_test",
            "silhouette": silhouette,
        },
        "analysis_warnings": list(dict.fromkeys(warnings)),
    }
