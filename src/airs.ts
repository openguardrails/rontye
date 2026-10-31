/** Optional: send each model request to an OpenGuardrails runtime. Observe only; it decides nothing here. */
import { randomBytes } from "node:crypto";
import { userInfo } from "node:os";
import type { LlmProtocol } from "./model.js";

export const INTEGRATION = "rontye/0.1.0";

export interface AirsTarget {
  url: string;
  apiKey: string;
  agentId?: string;
}

export function airsFromEnv(env: NodeJS.ProcessEnv): AirsTarget | null {
  if (!env.OGR_API_KEY) return null;
  return {
    url: (env.OGR_RUNTIME_URL ?? "https://api.openguardrails.com").replace(/\/$/, ""),
    apiKey: env.OGR_API_KEY,
    ...(env.OGR_AGENT_ID ? { agentId: env.OGR_AGENT_ID } : {}),
  };
}

/** `connection` and not `session_hint`: a run holds many conversations, and a hint would merge them. */
export function guardEvent(runId: string, harness: string, protocol: LlmProtocol, payload: unknown, agentId?: string) {
  return {
    kind: "step/request",
    step_id: randomBytes(16).toString("hex"),
    agent_id: agentId ?? harness,
    agent_type: harness,
    agent_workspace: "",
    agent_user: userInfo().username,
    llm_protocol: protocol,
    payload,
    integration: INTEGRATION,
    connection: runId,
  };
}

export async function report(target: AirsTarget, event: unknown): Promise<{ decision: string; findings: number }> {
  const response = await fetch(`${target.url}/v1/evaluate`, {
    method: "POST",
    headers: { authorization: `Bearer ${target.apiKey}`, "content-type": "application/json" },
    body: JSON.stringify(event),
    signal: AbortSignal.timeout(5000),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const verdict = (await response.json()) as { decision?: string; findings?: unknown[] };
  return { decision: verdict.decision ?? "?", findings: verdict.findings?.length ?? 0 };
}
