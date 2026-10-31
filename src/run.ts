/** `rontye run`: start a command in the sandbox and record what its whole process tree does. */
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import zlib from "node:zlib";
import { SandboxManager, type FilterRequestCallback, type SandboxRuntimeConfig } from "@anthropic-ai/sandbox-runtime";
import { airsFromEnv, guardEvent, report } from "./airs.js";
import { Correlator } from "./correlate.js";
import { classifyModelRequest, harnessFrom, hostsIn, toolCallsIn, toolResultIdsIn, type LlmProtocol } from "./model.js";
import { buildPolicy, type PolicyOptions } from "./policy.js";
import { Recorder, safePath } from "./record.js";

export interface RunOptions extends Omit<PolicyOptions, "cwd"> {
  enforce: boolean;
  command: string[];
}

/** A connection waits this long for the tool call that names it, which only arrives with the next model request. */
const GRACE_MS = 120_000;

function decode(bytes: Buffer, encoding: string): Buffer {
  switch (encoding) {
    case "gzip": return zlib.gunzipSync(bytes);
    case "br": return zlib.brotliDecompressSync(bytes);
    case "deflate": return zlib.inflateSync(bytes);
    case "zstd": return zlib.zstdDecompressSync(bytes);
    default: return bytes;
  }
}

const quote = (arg: string) => (/^[\w@%+=:,./-]+$/.test(arg) ? arg : `'${arg.replaceAll("'", `'\\''`)}'`);

export async function run(options: RunOptions): Promise<number> {
  const runId = `${new Date().toISOString().replace(/[-:.]/g, "").slice(0, 15)}-${randomBytes(3).toString("hex")}`;
  const recorder = new Recorder(runId);
  const correlator = new Correlator();
  const airs = airsFromEnv(process.env);
  const seenCalls = new Set<string>();
  const command = options.command.map(quote).join(" ");

  // Set once a tool result answers a call this run never saw. From then on "no tool call named it"
  // cannot be claimed, because a call we cannot see may have named it.
  const blindTo = new Set<string>();

  const flush = (final = false) => {
    for (const found of correlator.flush(Date.now(), GRACE_MS, final)) {
      const { bytesUp, ...rest } = found;
      const verified = blindTo.size === 0;
      recorder.write(verified ? "undeclared" : "unverified", { ...rest, bytes_up: bytesUp, blind_to: [...blindTo] });
      const label = verified ? "undeclared destination" : "unverified destination";
      process.stderr.write(`[rontye] ${label}: ${found.host} (${found.methods.join("/")}, ${bytesUp}B up)\n`);
    }
  };

  const readModelRequest = async (request: Request, host: string, protocol: LlmProtocol) => {
    const harness = harnessFrom(request.headers.get("user-agent") ?? "");
    let body: any;
    try {
      const raw = Buffer.from(await new Response(request.body).arrayBuffer());
      body = JSON.parse(decode(raw, request.headers.get("content-encoding") ?? "").toString("utf8"));
    } catch (error) {
      recorder.write("model", { harness, host, protocol, unparsed: String(error) });
      return;
    }
    recorder.write("model", { harness, host, protocol, model: body?.model });
    for (const call of toolCallsIn(protocol, body)) {
      if (seenCalls.has(call.id)) continue;
      seenCalls.add(call.id);
      const hosts = hostsIn(call.args);
      correlator.noteDeclared(hosts);
      recorder.write("tool_call", { harness, name: call.name, hosts });
    }
    if (toolResultIdsIn(protocol, body).some((id) => !seenCalls.has(id))) blindTo.add(harness);
    flush();
    if (airs) {
      report(airs, guardEvent(runId, harness, protocol, body, airs.agentId))
        .then((verdict) => recorder.write("verdict", verdict))
        .catch((error) => recorder.write("verdict", { decision: "unjudged", findings: 0, error: String(error) }));
    }
  };

  // Answers straight away and reads the body beside the forward, so recording never delays a request.
  const filterRequest: FilterRequestCallback = async (request, info) => {
    const url = new URL(request.url);
    const host = info?.target?.host ?? url.hostname;
    const bytes = Number(request.headers.get("content-length") ?? 0);
    const protocol = classifyModelRequest(request.method, url.pathname);
    if (protocol) {
      correlator.noteModelHost(host);
      void readModelRequest(request, host, protocol);
    } else {
      correlator.noteConnection(host, request.method, bytes, Date.now());
      recorder.write("request", { method: request.method, host, path: safePath(url.pathname), bytes });
    }
    return { action: "allow" };
  };

  const config: SandboxRuntimeConfig = {
    ...buildPolicy({ ...options, cwd: process.cwd() }),
  };
  config.network = { ...config.network, tlsTerminate: {}, filterRequest } as typeof config.network;

  const deps = SandboxManager.checkDependencies();
  if (deps.errors.length > 0) {
    process.stderr.write(`[rontye] cannot start: ${deps.errors.join("; ")}\n`);
    return 127;
  }

  const ask = async ({ host, port }: { host: string; port?: number | undefined }) => {
    recorder.write("connect", { host, port, allowed: !options.enforce });
    if (!options.enforce) return true;
    return { allow: false as const, reason: `rontye: ${host} is not allowed. Add it with --allow-host ${host}` };
  };
  // The third argument turns on the violation monitor; denied reads are not reported without it.
  await SandboxManager.initialize(config, ask, true);

  const seenViolations = new Set<string>();
  const unsubscribe = SandboxManager.getSandboxViolationStore().subscribe((violations) => {
    for (const violation of violations) {
      const key = `${violation.timestamp.getTime()}:${violation.line}`;
      if (seenViolations.has(key)) continue;
      seenViolations.add(key);
      // macOS reports every process's routine system probes; only files and network mean anything here.
      if (/deny\S* (sysctl|system-info|mach-|iokit|ipc-|process-info)/.test(violation.line)) continue;
      recorder.write("violation", { line: violation.line });
    }
  });

  recorder.write("start", { mode: options.enforce ? "enforce" : "observe", command: options.command[0], run: runId });
  // sandbox-runtime exempts loopback and private ranges from the proxy, and those clients then fail
  // inside the sandbox. A local vLLM is what this tool exists to see, so everything goes through it.
  const wrapped = await SandboxManager.wrapWithSandbox(`NO_PROXY= no_proxy= ${command}`, undefined, undefined, undefined, {
    commandId: runId,
    commandText: command,
  });
  const child = spawn(wrapped, { shell: true, stdio: "inherit" });
  for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => child.kill(signal));
  const code = await new Promise<number>((resolve) => {
    child.on("error", () => resolve(127));
    child.on("exit", (exitCode, signal) => resolve(exitCode ?? (signal ? 128 : 1)));
  });

  // The macOS violation monitor reads an asynchronous system log, and body reads may be in flight.
  await new Promise((resolve) => setTimeout(resolve, 1500));
  flush(true);
  recorder.write("exit", { code });
  unsubscribe();
  await SandboxManager.reset();
  process.stderr.write(`[rontye] run ${runId} recorded. See: rontye log ${runId}\n`);
  return code;
}
