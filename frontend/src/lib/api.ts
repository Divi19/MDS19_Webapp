import type {
  HealthResponse,
  PathwayRequest,
  PathwayResponse,
  PredictionResponse,
  ROIAnalysisRequest,
  ROIAnalysisResponse,
} from "@/lib/types";

export type {
  HealthResponse,
  PathwayRequest,
  PathwayResponse,
  PredictionResponse,
  ROIAnalysisRequest,
  ROIAnalysisResponse,
} from "@/lib/types";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000";

async function apiError(response: Response, fallback: string): Promise<Error> {
  let detail = "";
  try {
    const body = (await response.json()) as { detail?: unknown };
    if (typeof body.detail === "string") detail = body.detail;
    else if (Array.isArray(body.detail)) {
      detail = body.detail
        .map((item) =>
          typeof item === "object" && item && "msg" in item ? String(item.msg) : String(item),
        )
        .join("; ");
    }
  } catch {
    detail = await response.text().catch(() => "");
  }
  return new Error(detail || `${fallback} (${response.status})`);
}

async function postJSON<T>(path: string, payload: unknown, fallback: string): Promise<T> {
  const response = await fetch(`${API_URL}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!response.ok) throw await apiError(response, fallback);
  return response.json() as Promise<T>;
}

export async function predict(
  file: File,
  her2PositiveBreastTissueConfirmed: boolean,
  heStainConfirmed: boolean,
  micronsPerPixel: number,
): Promise<PredictionResponse> {
  const formData = new FormData();
  formData.append("file", file);
  formData.append(
    "her2_positive_breast_tissue",
    String(her2PositiveBreastTissueConfirmed),
  );
  formData.append("stain", heStainConfirmed ? "H&E" : "not confirmed");
  formData.append("microns_per_pixel", String(micronsPerPixel));

  const response = await fetch(`${API_URL}/api/predict`, {
    method: "POST",
    body: formData,
  });
  if (!response.ok) throw await apiError(response, "Prediction request failed");
  return response.json() as Promise<PredictionResponse>;
}

export function analyzeROI(payload: ROIAnalysisRequest): Promise<ROIAnalysisResponse> {
  return postJSON<ROIAnalysisResponse>("/api/analysis/roi", payload, "ROI analysis failed");
}

export function analyzePathways(payload: PathwayRequest): Promise<PathwayResponse> {
  return postJSON<PathwayResponse>(
    "/api/analysis/pathways",
    payload,
    "Pathway analysis failed",
  );
}

export async function checkHealth(): Promise<HealthResponse> {
  const response = await fetch(`${API_URL}/api/health`);
  if (!response.ok) throw await apiError(response, "API unreachable");
  return response.json() as Promise<HealthResponse>;
}

/** Deterministic client-side k-means for the five-cluster UI. */
// Farthest-first seeds are deterministic and avoid random UI changes.
/** Convert the API contract into the shape consumed by the existing visualisation. */
// Every gene actually found in the tissue, ranked by its own raw mean
// expression across all spots — not just the backend's top-50 shortlist.
// This is the full panel, not a slice of it; the UI paginates it rather
// than truncating it.
