/**
 * The gateway: one local base URL in front of many model APIs, trying them in order.
 * It rewrites the model name and the key and nothing else: it does not translate protocols, so
 * the members of a route must speak the protocol their client speaks.
 */
import { randomBytes } from "node:crypto";
import { appendFileSync, mkdirSync } from "node:fs";
import http, { type IncomingHttpHeaders, type IncomingMessage, type ServerResponse } from "node:http";
import https from "node:https";
import { hostname, userInfo } from "node:os";
import { join } from "node:path";
import zlib from "node:zlib";
import { INTEGRATION } from "./airs.js";
import { rontyeHome, resolveRoute, secretOf, type Config, type Upstream } from "./config.js";
import { classifyModelRequest, harnessFrom, hostsIn, toolCallsIn, toolResultIdsIn, type LlmProtocol } from "./model.js";

type Gateway = NonNullable<Config["gateway"]>;

/** The request's fault: another upstream would refuse it too, so it goes back to the client. */
export const isFailoverStatus = (status: number) => status >= 500 || [401, 403, 404, 408, 429].includes(status);

export function rewriteBody(body: Record<string, any>, upstream: Upstream): Record<string, any> {
  const out: Record<string, any> = { ...body, model: upstream.model };
  const kwargs = body.chat_template_kwargs;
  if (upstream.renameTemplateKwargs && kwargs && typeof kwargs === "object") {
    out.chat_template_kwargs = Object.fromEntries(
      Object.entries(kwargs).map(([key, value]) => [upstream.renameTemplateKwargs![key] ?? key, value]),
    );
  }
  return out;
}

/** The URL for a client path: /v1/chat/completions on a base of http://h/v1 is http://h/v1/chat/completions. */
export function upstreamUrl(baseURL: string, clientPath: string): URL {
  const base = baseURL.replace(/\/$/, "");
  return new URL(base + clientPath.replace(/^\/v1(?=\/)/, ""));
}

const HOP_BY_HOP = new Set(["host", "connection", "content-length", "content-encoding", "transfer-encoding", "keep-alive", "te", "trailer", "upgrade", "proxy-connection", "proxy-authorization"]);

export function upstreamHeaders(client: IncomingHttpHeaders, protocol: LlmProtocol | null, key: string | undefined): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(client)) {
    if (!HOP_BY_HOP.has(name) && typeof value === "string") headers[name] = value;
  }
  if (key) {
    delete headers.authorization;
    delete headers["x-api-key"];
    if (protocol === "anthropic.messages") headers["x-api-key"] = key;
    else headers.authorization = `Bearer ${key}`;
  }
  return headers;
}

/** Remembers which upstreams just failed, so a dead one does not cost every request a timeout. */
export class Health {
  private readonly until = new Map<string, number>();
  constructor(private readonly cooldownMs: number) {}
  fail(name: string, now = Date.now()): void {
    this.until.set(name, now + this.cooldownMs);
  }
  ok(name: string): void {
    this.until.delete(name);
  }
  /** Healthy members first in their order; cooling ones after, since one may have recovered. */
  order(members: string[], now = Date.now()): string[] {
    const cooling = (name: string) => (this.until.get(name) ?? 0) > now;
    return [...members.filter((name) => !cooling(name)), ...members.filter(cooling)];
  }
  cooling(now = Date.now()): string[] {
    return [...this.until].filter(([, until]) => until > now).map(([name]) => name);
  }
}

const decode = (bytes: Buffer, encoding: string | undefined): Buffer => {
  switch (encoding) {
    case "gzip": return zlib.gunzipSync(bytes);
    case "br": return zlib.brotliDecompressSync(bytes);
    case "deflate": return zlib.inflateSync(bytes);
    case "zstd": return zlib.zstdDecompressSync(bytes);
    default: return bytes;
  }
};

const readAll = (stream: IncomingMessage): Promise<Buffer> =>
  new Promise((resolve, reject) => {
    const parts: Buffer[] = [];
    stream.on("data", (part: Buffer) => parts.push(part));
    stream.on("end", () => resolve(Buffer.concat(parts)));
    stream.on("error", reject);
  });

/** Beyond this a reply is forwarded but not sent for judging; a process must not grow without bound. */
const MAX_JUDGED_REPLY_BYTES = 64 * 1024 * 1024;

export function startGateway(config: Config): Promise<http.Server> {
  const gateway = config.gateway as Gateway;
  const health = new Health(gateway.cooldownMs ?? 30_000);
  const connectTimeoutMs = gateway.connectTimeoutMs ?? 5_000;
  const firstByteTimeoutMs = gateway.firstByteTimeoutMs ?? 600_000;
  const airs = config.airs;
  const airsKey = airs ? secretOf(airs) : undefined;
  let lastFailover: unknown = null;
  let served = 0;
  // What runs ask for, since agents reach the gateway directly and their calls never pass the proxy.
  const seenCalls = new Set<string>();
  const activity: Array<{ t: number; agent: string; name: string; hosts: string[] }> = [];
  const blindTo = new Set<string>();

  mkdirSync(rontyeHome(), { recursive: true, mode: 0o700 });
  const log = (type: string, fields: Record<string, unknown>) =>
    appendFileSync(join(rontyeHome(), "gateway.ndjson"), `${JSON.stringify({ t: new Date().toISOString(), type, ...fields })}\n`, { mode: 0o600 });

  const identity = (agentType: string) => ({
    id: airs?.agentId ?? `${agentType}-${hostname()}`,
    type: agentType,
    workspace: airs?.agentWorkspace ?? "",
    user: userInfo().username,
  });

  const postVerdict = async (kind: string, stepId: string, init: { headers: Record<string, string>; body: string | Buffer }) => {
    try {
      const response = await fetch(`${airs!.url.replace(/\/$/, "")}/v1/evaluate`, {
        method: "POST",
        headers: { authorization: `Bearer ${airsKey}`, ...init.headers },
        body: init.body as BodyInit,
        signal: AbortSignal.timeout(30_000),
      });
      const verdict = (await response.json().catch(() => ({}))) as { decision?: string; findings?: unknown[]; event_id?: string };
      // A 200 without a decision is not a verdict.
      if (!response.ok || !verdict.decision) throw new Error(`HTTP ${response.status}`);
      log("verdict", { kind, step: stepId, decision: verdict.decision, findings: verdict.findings?.length ?? 0 });
    } catch (error) {
      log("verdict", { kind, step: stepId, decision: "unjudged", error: String(error) });
    }
  };

  const reportRequest = (stepId: string, protocol: LlmProtocol, payload: unknown, agentType: string, endpoint: string) => {
    if (!airsKey) return Promise.resolve();
    const who = identity(agentType);
    return postVerdict("step/request", stepId, {
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        kind: "step/request", step_id: stepId, agent_id: who.id, agent_type: who.type, agent_workspace: who.workspace,
        agent_user: who.user, llm_protocol: protocol, payload, integration: INTEGRATION, llm_endpoint: endpoint,
      }),
    });
  };

  const reportResponse = (stepId: string, protocol: LlmProtocol, reply: Buffer, contentType: string, agentType: string, endpoint: string) => {
    const who = identity(agentType);
    if (contentType.includes("text/event-stream")) {
      return postVerdict("step/response", stepId, {
        headers: {
          "content-type": "text/event-stream", "ogr-kind": "step/response", "ogr-step-id": stepId, "ogr-llm-protocol": protocol,
          "ogr-agent-id": who.id, "ogr-agent-type": who.type, "ogr-agent-workspace": who.workspace, "ogr-agent-user": who.user,
          "ogr-integration": INTEGRATION, "ogr-llm-endpoint": endpoint,
        },
        body: reply,
      });
    }
    return postVerdict("step/response", stepId, {
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        kind: "step/response", step_id: stepId, agent_id: who.id, agent_type: who.type, agent_workspace: who.workspace,
        agent_user: who.user, llm_protocol: protocol, payload: JSON.parse(reply.toString("utf8")), integration: INTEGRATION, llm_endpoint: endpoint,
      }),
    });
  };

  /** One attempt. Resolves with why it failed, or null once the reply is the client's. */
  const attempt = (name: string, upstream: Upstream, path: string, protocol: LlmProtocol | null, method: string, clientHeaders: IncomingHttpHeaders, body: Buffer | null, res: ServerResponse, onReply: (reply: Buffer | null, contentType: string) => void): Promise<string | null> =>
    new Promise((resolve) => {
      const url = upstreamUrl(upstream.baseURL, path);
      const headers = upstreamHeaders(clientHeaders, protocol, secretOf(upstream));
      if (body) headers["content-length"] = String(body.length);
      let settled = false;
      let replied = false;
      let clientGone = false;
      const settle = (reason: string | null) => {
        if (settled) return;
        settled = true;
        clearTimeout(firstByteTimer);
        resolve(reason);
      };
      const client = (url.protocol === "https:" ? https : http).request(url, { method, headers }, (upstreamRes) => {
        const status = upstreamRes.statusCode ?? 502;
        if (isFailoverStatus(status)) {
          upstreamRes.resume();
          return settle(`HTTP ${status}`);
        }
        const contentType = String(upstreamRes.headers["content-type"] ?? "");
        const parts: Buffer[] = [];
        let size = 0;
        let started = false;
        // The head waits for the first byte: until a byte has gone out, a failure can still fail over.
        const start = () => {
          started = true;
          clearTimeout(firstByteTimer);
          settle(null);
          const out = { ...upstreamRes.headers, "x-rontye-upstream": name } as IncomingHttpHeaders;
          delete out.connection;
          delete out["keep-alive"];
          delete out["transfer-encoding"];
          res.writeHead(status, out);
        };
        upstreamRes.on("data", (chunk: Buffer) => {
          if (!started) start();
          res.write(chunk);
          size += chunk.length;
          if (size <= MAX_JUDGED_REPLY_BYTES) parts.push(chunk);
        });
        const finish = () => {
          if (replied) return;
          replied = true;
          const encoded = Buffer.concat(parts);
          let reply: Buffer | null = null;
          try {
            if (status < 400 && size <= MAX_JUDGED_REPLY_BYTES) reply = decode(encoded, upstreamRes.headers["content-encoding"] as string | undefined);
          } catch {
            reply = null;
          }
          onReply(reply, contentType);
        };
        upstreamRes.on("end", () => {
          if (!started) start();
          res.end();
          health.ok(name);
          finish();
        });
        upstreamRes.on("error", () => fail(started));
        upstreamRes.on("close", () => {
          if (upstreamRes.complete) return;
          // Clients often hang up on seeing the end marker. That is not the upstream failing, and
          // what arrived still gets judged.
          if (clientGone) {
            if (started) finish();
            return settle("the client went away");
          }
          fail(started);
        });
      });
      const fail = (started: boolean) => {
        if (!started) return settle("the stream ended before its first byte");
        // Too late to switch: bytes are out. The client sees a cut stream, and its retry skips this upstream.
        health.fail(name);
        log("cut", { upstream: name });
        res.destroy();
      };
      const firstByteTimer = setTimeout(() => {
        client.destroy();
        settle(`no first byte in ${firstByteTimeoutMs}ms`);
      }, firstByteTimeoutMs);
      client.on("socket", (socket) => {
        if (socket.connecting) {
          const timer = setTimeout(() => {
            client.destroy();
            settle(`no connection in ${connectTimeoutMs}ms`);
          }, connectTimeoutMs);
          socket.once("connect", () => clearTimeout(timer));
          socket.once("secureConnect", () => clearTimeout(timer));
          socket.once("close", () => clearTimeout(timer));
        }
      });
      client.on("error", (error) => settle(error.message));
      res.on("close", () => {
        if (res.writableEnded) return;
        clientGone = true;
        client.destroy();
      });
      client.end(body ?? undefined);
    });

  const json = (res: ServerResponse, status: number, value: unknown) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(value));
  };

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://gateway");
      if (url.pathname === "/__rontye/health") {
        return json(res, 200, { ok: true, pid: process.pid, served, cooling: health.cooling(), last_failover: lastFailover, airs: Boolean(airsKey) });
      }
      if (url.pathname === "/__rontye/activity") {
        const since = Number(url.searchParams.get("since") ?? 0);
        return json(res, 200, { served, blind_to: [...blindTo], calls: activity.filter((call) => call.t > since) });
      }
      if (req.method === "GET" && /\/models$/.test(url.pathname)) {
        const names = [...Object.keys(gateway.routes ?? {}), ...Object.keys(gateway.upstreams)];
        return json(res, 200, { object: "list", data: names.map((id) => ({ id, object: "model", owned_by: "rontye" })) });
      }
      const protocol = classifyModelRequest(req.method ?? "", url.pathname);
      if (!protocol) return json(res, 404, { error: { message: `rontye gateway does not serve ${req.method} ${url.pathname}` } });

      const parsed = JSON.parse(decode(await readAll(req), req.headers["content-encoding"] as string | undefined).toString("utf8"));
      const members = resolveRoute(gateway, parsed?.model);
      if (!members) {
        const known = [...Object.keys(gateway.routes ?? {}), ...Object.keys(gateway.upstreams)].join(", ");
        return json(res, 404, { error: { message: `rontye gateway has no model "${parsed?.model}". Known: ${known}` } });
      }

      served += 1;
      const stepId = randomBytes(16).toString("hex");
      const agentType = harnessFrom(req.headers["user-agent"] ?? "");
      for (const call of toolCallsIn(protocol, parsed)) {
        if (seenCalls.has(call.id)) continue;
        seenCalls.add(call.id);
        activity.push({ t: Date.now(), agent: agentType, name: call.name, hosts: hostsIn(call.args) });
        if (activity.length > 5000) activity.shift();
      }
      if (toolResultIdsIn(protocol, parsed).some((id) => !seenCalls.has(id))) blindTo.add(agentType);
      const failures: string[] = [];
      for (const name of health.order(members)) {
        const upstream = gateway.upstreams[name]!;
        const body = Buffer.from(JSON.stringify(rewriteBody(parsed, upstream)));
        const endpoint = new URL(upstream.baseURL).host;
        let requestReported: Promise<void> = Promise.resolve();
        const reason = await attempt(name, upstream, url.pathname, protocol, req.method!, req.headers, body, res, (reply, contentType) => {
          log("step", { step: stepId, upstream: name, model: upstream.model, protocol, agent_type: agentType, reply_bytes: reply?.length ?? null });
          if (!airsKey || !reply) return;
          // Reported after the fact and never awaited by the client: the two halves stay in order.
          requestReported = reportRequest(stepId, protocol, rewriteBody(parsed, upstream), agentType, endpoint);
          void requestReported.then(() => reportResponse(stepId, protocol, reply, contentType, agentType, endpoint)).catch((error) => log("verdict", { step: stepId, decision: "unjudged", error: String(error) }));
        });
        if (reason === null) {
          if (failures.length > 0) {
            lastFailover = { to: name, failed: failures, t: new Date().toISOString() };
            log("failover", lastFailover as Record<string, unknown>);
            process.stderr.write(`[rontye] served by ${name} after: ${failures.join("; ")}\n`);
          }
          return;
        }
        if (res.destroyed) return;
        health.fail(name);
        failures.push(`${name}: ${reason}`);
      }
      log("exhausted", { failed: failures });
      return json(res, 502, { error: { message: `rontye gateway: every upstream failed. ${failures.join("; ")}`, type: "rontye_upstreams_failed" } });
    } catch (error) {
      if (!res.headersSent) return json(res, 400, { error: { message: `rontye gateway: ${String(error)}` } });
      res.destroy();
    }
  });
  // No proxy-side idle limit: a reasoning model can be silent for a long time.
  server.requestTimeout = 0;
  server.headersTimeout = 60_000;
  server.timeout = 0;
  const port = gateway.port ?? 4180;
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    // Loopback only: this process holds the keys.
    server.listen(port, "127.0.0.1", () => resolve(server));
  });
}
