from __future__ import annotations

import csv
import html
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


def prediction_response_json(prediction: PredictionResponse) -> bytes:
    return json.dumps(
        prediction.model_dump(mode="json"),
        sort_keys=True,
        separators=(",", ":"),
        allow_nan=False,
    ).encode("utf-8")


def _report_value(value: Any) -> str:
    if value is None:
        return "Not returned"
    if isinstance(value, bool):
        return "Yes" if value else "No"
    return html.escape(str(value))


def _report_rows(values: list[tuple[str, Any]]) -> str:
    return "".join(
        f"<tr><th>{html.escape(label)}</th><td>{_report_value(value)}</td></tr>"
        for label, value in values
    )


def _report_warnings(prediction: PredictionResponse) -> list[str]:
    return list(dict.fromkeys([*prediction.warnings, *prediction.qc.warnings, *prediction.analysis_warnings]))


def research_report_html(prediction: PredictionResponse) -> bytes:
    spatial_by_gene = {}
    if prediction.spatial_statistics is not None:
        spatial_by_gene = {item.gene_name: item for item in prediction.spatial_statistics.genes}
    gene_rows = "".join(
        "<tr>"
        f"<td>{html.escape(item.gene_name)}</td>"
        f"<td>{_report_value(item.mean_expression)}</td>"
        f"<td>{_report_value(item.variance_expression)}</td>"
        f"<td>{_report_value(spatial_by_gene[item.gene_name].morans_i) if item.gene_name in spatial_by_gene else 'Not returned'}</td>"
        f"<td>{_report_value(spatial_by_gene[item.gene_name].empirical_p_value) if item.gene_name in spatial_by_gene else 'Not returned'}</td>"
        f"<td>{_report_value(spatial_by_gene[item.gene_name].q_value) if item.gene_name in spatial_by_gene else 'Not returned'}</td>"
        "</tr>"
        for item in prediction.all_gene_summary.genes
    )
    domain_sections = []
    for domain in prediction.domain_summaries:
        marker_rows = "".join(
            "<tr>"
            f"<td>{html.escape(marker.gene_name)}</td>"
            f"<td>{marker.rank}</td>"
            f"<td>{_report_value(marker.effect_size)}</td>"
            f"<td>{_report_value(marker.welch_p_value)}</td>"
            f"<td>{_report_value(marker.q_value)}</td>"
            f"<td>{_report_value(marker.domain_mean)}</td>"
            f"<td>{_report_value(marker.rest_mean)}</td>"
            "</tr>"
            for marker in domain.markers
        )
        if not marker_rows:
            marker_rows = '<tr><td colspan="7">No domain markers were returned.</td></tr>'
        domain_sections.append(
            f"<h3>{html.escape(domain.domain_id)} · predicted-expression domain</h3>"
            f"<p><strong>Calculated tile count:</strong> {domain.tile_count}</p>"
            '<table><thead><tr><th>Gene</th><th>Rank</th><th>Effect size</th><th>Welch p</th><th>q</th><th>Domain mean</th><th>Rest mean</th></tr></thead>'
            f"<tbody>{marker_rows}</tbody></table>"
        )
    if not domain_sections:
        domain_sections.append("<p>No predicted-expression domains were returned.</p>")
    warnings = _report_warnings(prediction)
    warning_items = "".join(f"<li>{html.escape(item)}</li>" for item in warnings)
    if not warning_items:
        warning_items = "<li>No pipeline, QC, or analysis warnings were returned.</li>"
    analysis = prediction.analysis_method
    spatial = prediction.spatial_statistics
    retrieval_tiles = [tile.retrieval_support for tile in prediction.prediction_tiles if tile.retrieval_support is not None]
    retrieval_rows: list[tuple[str, Any]] = [
        ("Support label", prediction.model_metadata.retrieval_support_label),
        ("Neighbor selection", prediction.model_metadata.retrieval_neighbor_selection),
        ("Weighting", prediction.model_metadata.retrieval_weighting),
        ("Tiles with retrieval support", len(retrieval_tiles)),
    ]
    report = f"""<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Predicted spatial expression research report</title>
<style>
@page{{size:A4;margin:16mm}}*{{box-sizing:border-box}}body{{font:11px/1.45 Arial,sans-serif;color:#17252b;margin:0}}h1{{font-size:24px;margin:0 0 4px}}h2{{font-size:16px;border-bottom:2px solid #176f72;padding-bottom:4px;margin:24px 0 10px}}h3{{font-size:13px;margin:16px 0 5px}}p{{margin:6px 0}}.notice{{border:2px solid #176f72;padding:10px 12px;margin:14px 0;background:#eef8f7}}.warning{{border-left:4px solid #a95f0b;padding:7px 10px;background:#fff6e7}}table{{width:100%;border-collapse:collapse;margin:8px 0 14px;page-break-inside:auto}}tr{{page-break-inside:avoid}}th,td{{border:1px solid #cbd6d2;padding:5px;text-align:left;vertical-align:top}}th{{background:#eef3f1}}thead{{display:table-header-group}}ul{{padding-left:19px}}.meta{{color:#52656d}}footer{{margin-top:24px;border-top:1px solid #aebdb7;padding-top:7px;font-size:9px;color:#52656d}}@media print{{a{{color:inherit;text-decoration:none}}}}
</style>
</head>
<body>
<header><h1>Predicted spatial expression research report</h1><p class="meta">Prediction {html.escape(prediction.prediction_id)} · {html.escape(prediction.created_at.isoformat())}</p></header>
<div class="notice"><strong>Research use only.</strong> Every expression value in this report is a model prediction, not a measured assay value. This output is not a diagnosis, does not perform cell typing or identify biomarkers, is not equivalent to a laboratory measurement, and does not provide calibrated confidence.</div>
<h2>Scope and applicability</h2>
<p>The declared reference scope is shown exactly as returned. Applicability records submitted confirmations and whether the backend marked the request within that declared scope; it does not establish tissue identity.</p>
<table><tbody>{_report_rows([
        ('Reference scope', prediction.applicability.reference_scope),
        ('Within declared reference scope', prediction.applicability.within_reference_scope),
        ('HER2-positive breast tissue confirmed in request', prediction.applicability.her2_positive_breast_tissue_confirmed),
        ('H&E stain confirmed in request', prediction.applicability.he_stain_confirmed),
        ('Output mode', prediction.model_metadata.mode),
    ])}</tbody></table>
<h2>Quality control</h2>
<p>Calculated image and tile QC values returned by the backend. These checks do not validate biological identity or assay quality.</p>
<table><tbody>{_report_rows([
        ('Image width', prediction.qc.image_width), ('Image height', prediction.qc.image_height),
        ('Tissue fraction', prediction.qc.tissue_fraction), ('Brightness', prediction.qc.brightness),
        ('Contrast', prediction.qc.contrast), ('Mean saturation', prediction.qc.mean_saturation),
        ('Focus proxy', prediction.qc.focus_proxy), ('Accepted tile count', prediction.qc.accepted_tile_count),
        ('Rejected tile count', prediction.qc.rejected_tile_count),
    ])}</tbody></table>
<h2>Model and retrieval methods</h2>
<table><tbody>{_report_rows([
        ('Model version', prediction.model_version), ('Model metadata version', prediction.model_metadata.model_version),
        ('Output type', prediction.model_metadata.output_type), ('Panel size', prediction.model_metadata.panel_size),
        *retrieval_rows,
    ])}</tbody></table>
<p>Retrieval support values, when returned, are similarity, effective-neighbor, and expression-dispersion diagnostics. They are not calibrated confidence and do not convert predictions into measurements.</p>
<h2>Analysis methods</h2>
<table><tbody>{_report_rows([
        ('Result type', None if analysis is None else analysis.result_type),
        ('Variable gene selection', None if analysis is None else analysis.variable_gene_selection),
        ('Variable gene limit', None if analysis is None else analysis.variable_gene_limit),
        ('Standardization', None if analysis is None else analysis.standardization),
        ('PCA solver', None if analysis is None else analysis.pca_solver),
        ('Requested domains', None if analysis is None else analysis.kmeans_requested_k),
        ('Fitted domains', None if analysis is None else analysis.kmeans_fitted_k),
        ('K-means seed', None if analysis is None else analysis.kmeans_seed),
        ('K-means initializations', None if analysis is None else analysis.kmeans_n_init),
        ('K-means algorithm', None if analysis is None else analysis.kmeans_algorithm),
        ('Marker effect size', None if analysis is None else analysis.marker_effect_size),
        ('Marker test', None if analysis is None else analysis.marker_test),
        ('Silhouette', None if analysis is None else analysis.silhouette),
        ('Spatial neighbor method', None if spatial is None else spatial.neighbor_method),
        ('Spatial neighbor count', None if spatial is None else spatial.neighbor_count),
        ('Spatial permutations', None if spatial is None else spatial.permutations),
        ('Spatial seed', None if spatial is None else spatial.seed),
        ('Spatial p-value method', None if spatial is None else spatial.p_value_method),
        ('Multiple testing method', None if spatial is None else spatial.multiple_testing_method),
    ])}</tbody></table>
<h2>Warnings and limitations</h2><div class="warning"><ul>{warning_items}</ul></div>
<p>Domain markers are calculated contrasts of predicted values, not measured markers or validated biomarkers. Domain labels group similar predicted-expression profiles and are not cell types or pathology classes.</p>
<h2>Gene summary</h2>
<p>Raw model-scale predicted-expression summaries are reproduced without rescaling. Spatial statistics are calculated from those predictions.</p>
<table><thead><tr><th>Gene</th><th>Raw mean</th><th>Raw variance</th><th>Moran's I</th><th>Empirical p</th><th>q</th></tr></thead><tbody>{gene_rows}</tbody></table>
<h2>Predicted-expression domain summaries</h2>{''.join(domain_sections)}
<h2>Provenance</h2>
<table><tbody>{_report_rows([
        ('Prediction ID', prediction.prediction_id), ('Created at', prediction.created_at.isoformat()),
        ('Status', prediction.status), ('Model version', prediction.model_version),
        ('Image format', prediction.image_metadata.format), ('Source width pixels', prediction.image_metadata.width_pixels),
        ('Source height pixels', prediction.image_metadata.height_pixels), ('Microns per pixel', prediction.image_metadata.microns_per_pixel),
        ('Target microns per pixel', prediction.image_metadata.target_microns_per_pixel),
        ('Resampled width pixels', prediction.image_metadata.resampled_width_pixels),
        ('Resampled height pixels', prediction.image_metadata.resampled_height_pixels),
        ('Coordinate units', prediction.coordinate_metadata.x_y_units), ('Bounds units', prediction.coordinate_metadata.bounds_units),
        ('Coordinate origin', prediction.coordinate_metadata.origin), ('Coordinate semantics', prediction.coordinate_metadata.x_y_semantics),
        ('Prediction tiles', len(prediction.prediction_tiles)), ('Domain assignments', len(prediction.domain_assignments)),
    ])}</tbody></table>
<footer>Generated deterministically from the exported PredictionResponse. Research use only · predicted, not measured.</footer>
</body>
</html>"""
    return report.encode("utf-8")


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
        "prediction-response.json": prediction_response_json(prediction),
        "research-report.html": research_report_html(prediction),
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
        "prediction-response.json": (prediction_response_json, "application/json"),
        "research-report.html": (research_report_html, "text/html"),
        "roi.geojson": (lambda _: roi_geojson(export_request), "application/geo+json"),
        "prediction.h5ad": (h5ad_bytes, "application/x-hdf5"),
    }
    if artifact not in artifacts:
        raise ExportError("EXPORT_ARTIFACT_NOT_FOUND", 404)
    function, media_type = artifacts[artifact]
    return function(prediction), media_type, artifact
