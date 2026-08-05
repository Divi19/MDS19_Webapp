"use client";

import { useState } from "react";
import { predict, type PredictionResponse } from "@/lib/api";

export default function Home() {
  const [result, setResult] = useState<PredictionResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;

    setLoading(true);
    setError(null);
    try {
      setResult(await predict(file));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error");
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="p-8 max-w-3xl mx-auto">
      <h1 className="text-2xl font-semibold mb-6">
        Spatial Gene Expression Prediction
      </h1>

      <input
        type="file"
        accept="image/*"
        onChange={handleUpload}
        className="mb-6 block"
      />

      {loading && <p>Predicting…</p>}
      {error && <p className="text-red-600">{error}</p>}

      {result && (
        <div className="space-y-4">
          <p className="text-sm text-gray-600">
            {result.spots.length} spots · model {result.model_version}
          </p>
          <div>
            <h2 className="font-medium mb-2">Top genes</h2>
            <ul className="text-sm space-y-1">
              {result.top_genes.slice(0, 10).map((g) => (
                <li key={g.gene_name}>
                  {g.rank}. {g.gene_name} — {g.mean_expression.toFixed(3)}
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}
    </main>
  );
}