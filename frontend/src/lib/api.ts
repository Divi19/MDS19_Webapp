const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000";

export interface SpotPrediction {
  spot_index: number;
  x: number;
  y: number;
  expression: Record<string, number>;
}

export interface GeneRanking {
  gene_name: string;
  mean_expression: number;
  rank: number;
}

export interface PredictionResponse {
  prediction_id: string;
  status: string;
  model_version: string;
  created_at: string;
  spots: SpotPrediction[];
  top_genes: GeneRanking[];
}

export async function predict(file: File): Promise<PredictionResponse> {
  const formData = new FormData();
  formData.append("file", file);

  const res = await fetch(`${API_URL}/api/predict`, {
    method: "POST",
    body: formData,
  });

  if (!res.ok) {
    const detail = await res.text();
    throw new Error(`Prediction failed (${res.status}): ${detail}`);
  }

  return res.json();
}

export async function checkHealth() {
  const res = await fetch(`${API_URL}/api/health`);
  if (!res.ok) throw new Error("API unreachable");
  return res.json();
}