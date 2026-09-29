"use client";

import useSWR from "swr";
import { checkHealth } from "@/lib/api";

type ServiceState = "online" | "starting" | "checking";

function useServiceState(): ServiceState {
  const { data, error, isLoading } = useSWR("api-health", checkHealth, {
    refreshInterval: (latest) => (latest ? 120_000 : 15_000),
    shouldRetryOnError: true,
    errorRetryInterval: 15_000,
    revalidateOnFocus: false,
  });
  if (isLoading && !data) return "checking";
  if (error || !data) return "starting";
  return "online";
}

const LABEL: Record<ServiceState, string> = {
  online: "Prediction service online",
  starting: "Prediction service starting up",
  checking: "Checking prediction service",
};

export default function StatusBar() {
  const state = useServiceState();

  return (
    <footer className="status-bar">
      <p className="status-disclaimer">
        <strong>Research use only.</strong> Predictions are model outputs, not diagnostic results, and must not be used
        for clinical decisions.
      </p>
      <div className="status-service" role="status" aria-live="polite">
        <span className={`status-dot status-dot-${state}`} aria-hidden="true" />
        <span>{LABEL[state]}</span>
      </div>
    </footer>
  );
}
