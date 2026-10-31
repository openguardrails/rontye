/** Optional: send each model request to an OpenGuardrails runtime. Observe only; it decides nothing here. */
import { randomBytes } from "node:crypto";
import { userInfo } from "node:os";
import { secretOf } from "./config.js";
export const INTEGRATION = "rontye/0.2.0";
export function airsTarget(config) {
    const apiKey = config.airs ? secretOf(config.airs) : undefined;
    if (!config.airs || !apiKey)
        return null;
    return {
        url: config.airs.url.replace(/\/$/, ""),
        apiKey,
        ...(config.airs.agentId ? { agentId: config.airs.agentId } : {}),
    };
}
/** `connection` and not `session_hint`: a run holds many conversations, and a hint would merge them. */
export function guardEvent(runId, harness, protocol, payload, agentId) {
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
export async function report(target, event) {
    const response = await fetch(`${target.url}/v1/evaluate`, {
        method: "POST",
        headers: { authorization: `Bearer ${target.apiKey}`, "content-type": "application/json" },
        body: JSON.stringify(event),
        signal: AbortSignal.timeout(5000),
    });
    if (!response.ok)
        throw new Error(`HTTP ${response.status}`);
    const verdict = (await response.json());
    return { decision: verdict.decision ?? "?", findings: verdict.findings?.length ?? 0 };
}
