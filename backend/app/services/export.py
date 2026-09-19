from __future__ import annotations

import csv
import io
import json
import zipfile
from typing import Any

import h5py
import numpy as np

from app.models.schemas import ExportRequest, PredictionResponse


MAX_EXPORT_REQUEST_BYTES = 25 * 1024 * 1024
MAX_EXPORT_MATRIX_VALUES = 500_000


class ExportError(ValueError):
    def __init__(self, code: str, status_code: int = 422):
        self.code = code
        self.status_code = status_code
        super().__init__(code)


def validate_content_length(content_length: str | None) -> None:
    if content_length is None:
        return
    try:
        size = int(content_length)
    except ValueError as exc:
        raise ExportError("EXPORT_INVALID_CONTENT_LENGTH", 422) from exc
    if size > MAX_EXPORT_REQUEST_BYTES:
        raise ExportError("EXPORT_PAYLOAD_TOO_LARGE", 413)


def _prediction_matrix(prediction: PredictionResponse) -> tuple[list[str], np.ndarray, list[Any], dict[int, str]]:
    tiles = prediction.prediction_tiles
    if not tiles:
        raise ExportError("EXPORT_NO_PREDICTION_TILES")
    genes = list(tiles[0].expression)
    if not genes:
        raise ExportError("EXPORT_EMPTY_GENE_PANEL")
    matrix = np.empty((len(tiles), len(genes)), dtype=np.float64)
    seen = set()
    for row, tile in enumerate(tiles):
        if set(tile.expression) != set(genes):
            raise ExportError("EXPORT_INCOMPATIBLE_GENE_PANEL")
        tile_index = tile.tile_index if tile.tile_index is not None else tile.spot_index
        if tile_index in seen:
            raise ExportError("EXPORT_DUPLICATE_TILE_INDEX")
        seen.add(tile_index)
        matrix[row] = [tile.expression[gene] for gene in genes]
    if matrix.size > MAX_EXPORT_MATRIX_VALUES:
        raise ExportError("EXPORT_MATRIX_TOO_LARGE", 413)
    if not np.all(np.isfinite(matrix)):
        raise ExportError("EXPORT_NONFINITE_EXPRESSION")
    domains = {assignment.tile_index: assignment.domain_id for assignment in prediction.domain_assignments}
    return genes, matrix, tiles, domains


def expression_csv(prediction: PredictionResponse) -> bytes:
    genes, matrix, tiles, domains = _prediction_matrix(prediction)
    output = io.StringIO(newline="")
    writer = csv.writer(output, lineterminator="\n")
    writer.writerow(["tile_index", "spot_index", "x_original_pixels", "y_original_pixels", "predicted_expression_domain", *genes])
    for row, tile in enumerate(tiles):
        tile_index = tile.tile_index if tile.tile_index is not None else tile.spot_index
        writer.writerow([tile_index, tile.spot_index, tile.x, tile.y, domains.get(tile_index, ""), *[float(value) for value in matrix[row]]])
    return output.getvalue().encode("utf-8")


def gene_summary_csv(prediction: PredictionResponse) -> bytes:
    spatial = {}
    if prediction.spatial_statistics is not None:
        spatial = {gene.gene_name: gene for gene in prediction.spatial_statistics.genes}
    output = io.StringIO(newline="")
    writer = csv.writer(output, lineterminator="\n")
    writer.writerow(["gene_name", "mean_expression", "variance_expression", "morans_i", "empirical_p_value", "q_value"])
    for summary in prediction.all_gene_summary.genes:
        statistic = spatial.get(summary.gene_name)
        writer.writerow([
            summary.gene_name,
            summary.mean_expression,
            summary.variance_expression,
            "" if statistic is None or statistic.morans_i is None else statistic.morans_i,
            "" if statistic is None else statistic.empirical_p_value,
            "" if statistic is None else statistic.q_value,
        ])
    return output.getvalue().encode("utf-8")


def domain_summary_csv(prediction: PredictionResponse) -> bytes:
    output = io.StringIO(newline="")
    writer = csv.writer(output, lineterminator="\n")
    writer.writerow(["domain_id", "label", "tile_count", "marker_count"])
    for summary in prediction.domain_summaries:
        writer.writerow([summary.domain_id, summary.label, summary.tile_count, len(summary.markers)])
    return output.getvalue().encode("utf-8")


def domain_markers_csv(prediction: PredictionResponse) -> bytes:
    output = io.StringIO(newline="")
    writer = csv.writer(output, lineterminator="\n")
    writer.writerow(["domain_id", "gene_name", "rank", "effect_size", "welch_p_value", "q_value", "domain_mean", "rest_mean", "domain_detection_fraction", "rest_detection_fraction"])
    for summary in prediction.domain_summaries:
        for marker in summary.markers:
            writer.writerow([
                summary.domain_id,
                marker.gene_name,
                marker.rank,
                marker.effect_size,
                marker.welch_p_value,
                marker.q_value,
                marker.domain_mean,
                marker.rest_mean,
                marker.domain_detection_fraction,
                marker.rest_detection_fraction,
            ])
    return output.getvalue().encode("utf-8")


def manifest_json(prediction: PredictionResponse) -> bytes:
    manifest = {
        "prediction_id": prediction.prediction_id,
        "created_at": prediction.created_at.isoformat(),
        "status": prediction.status,
        "provenance": {
            "model_version": prediction.model_version,
            "model_metadata": prediction.model_metadata.model_dump(mode="json"),
            "image_metadata": prediction.image_metadata.model_dump(mode="json"),
            "coordinate_metadata": prediction.coordinate_metadata.model_dump(mode="json"),
            "qc": prediction.qc.model_dump(mode="json"),
            "applicability": prediction.applicability.model_dump(mode="json"),
        },
        "analysis_method": None if prediction.analysis_method is None else prediction.analysis_method.model_dump(mode="json"),
        "spatial_statistics_method": None if prediction.spatial_statistics is None else {
            key: value for key, value in prediction.spatial_statistics.model_dump(mode="json").items() if key != "genes"
        },
        "warnings": prediction.warnings,
        "analysis_warnings": prediction.analysis_warnings,
    }
    return json.dumps(manifest, sort_keys=True, separators=(",", ":"), allow_nan=False).encode("utf-8")


def roi_geojson(export_request: ExportRequest) -> bytes:
    available = {
        tile.tile_index if tile.tile_index is not None else tile.spot_index
        for tile in export_request.prediction.prediction_tiles
    }
    features = []
    for roi in export_request.roi_geometries:
        if not roi.tile_indices or any(tile_index not in available for tile_index in roi.tile_indices):
            raise ExportError("EXPORT_ROI_TILE_NOT_FOUND")
        geometry_type = roi.geometry.get("type")
        coordinates = roi.geometry.get("coordinates")
        if geometry_type not in {"Polygon", "MultiPolygon"} or not isinstance(coordinates, list):
            raise ExportError("EXPORT_INVALID_ROI_GEOMETRY")
        properties = dict(roi.properties)
        properties.update({"roi_id": roi.roi_id, "tile_indices": roi.tile_indices})
        features.append({"type": "Feature", "geometry": roi.geometry, "properties": properties})
    collection = {"type": "FeatureCollection", "features": features}
    return json.dumps(collection, sort_keys=True, separators=(",", ":"), allow_nan=False).encode("utf-8")


def _write_string_dataset(group: h5py.Group, name: str, values: list[str]) -> h5py.Dataset:
    dataset = group.create_dataset(name, data=np.asarray(values, dtype=h5py.string_dtype("utf-8")))
    dataset.attrs["encoding-type"] = "string-array"
    dataset.attrs["encoding-version"] = "0.2.0"
    return dataset


def _write_dataframe(group: h5py.Group, index_values: list[str], columns: dict[str, np.ndarray | list[str]]) -> None:
    group.attrs["encoding-type"] = "dataframe"
    group.attrs["encoding-version"] = "0.2.0"
    group.attrs["_index"] = "_index"
    group.attrs["column-order"] = np.asarray(list(columns), dtype=h5py.string_dtype("utf-8"))
    _write_string_dataset(group, "_index", index_values)
    for name, values in columns.items():
        if isinstance(values, list) and (not values or isinstance(values[0], str)):
            _write_string_dataset(group, name, values)
        else:
            dataset = group.create_dataset(name, data=np.asarray(values))
            dataset.attrs["encoding-type"] = "array"
            dataset.attrs["encoding-version"] = "0.2.0"


def h5ad_bytes(prediction: PredictionResponse) -> bytes:
    genes, matrix, tiles, domains = _prediction_matrix(prediction)
    buffer = io.BytesIO()
    with h5py.File(buffer, "w") as handle:
        handle.attrs["encoding-type"] = "anndata"
        handle.attrs["encoding-version"] = "0.1.0"
        x_data = handle.create_dataset("X", data=matrix, compression="gzip", shuffle=True)
        x_data.attrs["encoding-type"] = "array"
        x_data.attrs["encoding-version"] = "0.2.0"
        tile_indices = [tile.tile_index if tile.tile_index is not None else tile.spot_index for tile in tiles]
        obs = handle.create_group("obs")
        _write_dataframe(obs, [str(index) for index in tile_indices], {
            "tile_index": np.asarray(tile_indices, dtype=np.int64),
            "spot_index": np.asarray([tile.spot_index for tile in tiles], dtype=np.int64),
            "x_original_pixels": np.asarray([tile.x for tile in tiles], dtype=np.float64),
            "y_original_pixels": np.asarray([tile.y for tile in tiles], dtype=np.float64),
            "predicted_expression_domain": [domains.get(index, "") for index in tile_indices],
        })
        var = handle.create_group("var")
        _write_dataframe(var, genes, {})
        obsm = handle.create_group("obsm")
        obsm.attrs["encoding-type"] = "dict"
        obsm.attrs["encoding-version"] = "0.1.0"
        spatial = obsm.create_dataset("spatial", data=np.asarray([[tile.x, tile.y] for tile in tiles], dtype=np.float64))
        spatial.attrs["encoding-type"] = "array"
        spatial.attrs["encoding-version"] = "0.2.0"
        layers = handle.create_group("layers")
        layers.attrs["encoding-type"] = "dict"
        layers.attrs["encoding-version"] = "0.1.0"
        raw_layer = layers.create_dataset("raw_predicted_expression", data=matrix, compression="gzip", shuffle=True)
        raw_layer.attrs["encoding-type"] = "array"
        raw_layer.attrs["encoding-version"] = "0.2.0"
        uns = handle.create_group("uns")
        uns.attrs["encoding-type"] = "dict"
        uns.attrs["encoding-version"] = "0.1.0"
        provenance = manifest_json(prediction).decode("utf-8")
        _write_string_dataset(uns, "provenance_manifest_json", [provenance])
        _write_string_dataset(uns, "image_metadata_json", [json.dumps(prediction.image_metadata.model_dump(mode="json"), sort_keys=True)])
        _write_string_dataset(uns, "model_metadata_json", [json.dumps(prediction.model_metadata.model_dump(mode="json"), sort_keys=True)])
        _write_string_dataset(uns, "qc_json", [json.dumps(prediction.qc.model_dump(mode="json"), sort_keys=True)])
        _write_string_dataset(uns, "coordinate_units", [prediction.coordinate_metadata.x_y_units])
    return buffer.getvalue()


def export_bundle(export_request: ExportRequest) -> bytes:
    prediction = export_request.prediction
    artifacts = {
        "expression.csv": expression_csv(prediction),
        "gene_summary.csv": gene_summary_csv(prediction),
        "domain_summary.csv": domain_summary_csv(prediction),
        "domain_markers.csv": domain_markers_csv(prediction),
        "manifest.json": manifest_json(prediction),
        "roi.geojson": roi_geojson(export_request),
        "prediction.h5ad": h5ad_bytes(prediction),
    }
    output = io.BytesIO()
    with zipfile.ZipFile(output, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=6) as archive:
        for name, content in artifacts.items():
            info = zipfile.ZipInfo(name, date_time=(2020, 1, 1, 0, 0, 0))
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = 0o644 << 16
            archive.writestr(info, content)
    return output.getvalue()


def export_artifact(export_request: ExportRequest, artifact: str) -> tuple[bytes, str, str]:
    prediction = export_request.prediction
    artifacts = {
        "expression.csv": (expression_csv, "text/csv"),
        "gene-summary.csv": (gene_summary_csv, "text/csv"),
        "domain-summary.csv": (domain_summary_csv, "text/csv"),
        "domain-markers.csv": (domain_markers_csv, "text/csv"),
        "manifest.json": (manifest_json, "application/json"),
        "roi.geojson": (lambda _: roi_geojson(export_request), "application/geo+json"),
        "prediction.h5ad": (h5ad_bytes, "application/x-hdf5"),
    }
    if artifact not in artifacts:
        raise ExportError("EXPORT_ARTIFACT_NOT_FOUND", 404)
    function, media_type = artifacts[artifact]
    return function(prediction), media_type, artifact
