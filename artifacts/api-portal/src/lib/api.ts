const API_BASE = "/api";

export type SegmentName = "openai" | "anthropic" | "google" | "openrouter";

export interface SegmentStatus {
  segment: SegmentName;
  configured: boolean;
  baseUrlEnv: string;
  apiKeyEnv: string;
}

export interface SetupStatus {
  role: "upstream-pool-node";
  proxyKey: boolean;
  providers: Record<SegmentName, boolean>;
  segments: SegmentStatus[];
}

export async function fetchSetupStatus(): Promise<SetupStatus> {
  const res = await fetch(`${API_BASE}/setup-status`);
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}
