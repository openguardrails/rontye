# Ron Tye

**A local AI gateway, firewall and sandbox for your agents.**

Point your agents at one local base URL. Ron Tye fails over between your model APIs, keeps your API
keys out of the agents, walls off their files and network, and sends every model call to
[OpenGuardrails AIRS](https://openguardrails.com) to be judged.

Why: Claude Code and Codex come with guardrails. The subagents they dispatch, on a third-party
quantization or a relay, do not, and [weights can carry a backdoor](https://projectdiscovery.io/research/how-abliterated-models-can-get-you-pwned)
or [reach for places nobody asked them to](https://cohere.com/blog/concerning-behaviour-popular-open-weight-ai-model).

## If you are a person

Paste this to Claude Code or Codex:

> Set up Ron Tye on this machine by following the "If you are an agent" section of
> https://github.com/openguardrails/rontye/blob/main/README.md . Put my local agents behind it.

## If you are an agent

Do these steps in order. Ask the user only for what you cannot find yourself.

**Rules**

- Never print, log or commit an API key. To read a key from a config file, copy it with a script
  that does not echo it.
- Back up any config file before you edit it, and tell the user the backup's path.
- Do not stop or restart an agent the user is running. Tell them what to restart.
- Report what `rontye status` printed. Do not report success on any other evidence.

**1. Install.** Needs Node 22.12 or newer. macOS also needs `ripgrep`. Linux needs `bubblewrap`,
`socat` and `ripgrep`.

```sh
npm install -g https://github.com/openguardrails/rontye/archive/refs/heads/main.tar.gz
rontye --help
```

Use this URL rather than `github:openguardrails/rontye`: npm can leave a global git install as a
link to a temporary directory that is then deleted, and the command is simply not found.

**2. Find the model APIs.** Read the agent's own config for each base URL, model name and key.
See [Agents](#agents) for where each one keeps them. If the user gave a preference for which model
goes first, follow it. Otherwise ask.

**3. Write `~/.rontye/config.json`, mode 0600.**

```json
{
  "gateway": {
    "upstreams": {
      "primary": { "baseURL": "http://10.0.0.5:8000/v1", "model": "dsv41-flash", "apiKey": "local-no-auth" },
      "backup": { "baseURL": "https://openrouter.ai/api/v1", "model": "qwen/qwen3.8-27b", "apiKeyEnv": "OPENROUTER_API_KEY" }
    },
    "routes": { "auto": ["primary", "backup"] }
  },
  "airs": { "url": "https://airs.openguardrails.com", "apiKeyEnv": "OGR_AIRS_API_KEY", "agentId": "my-laptop" },
  "sandbox": { "allowHosts": ["10.0.0.5:8888"] }
}
```

- Prefer `apiKeyEnv` to `apiKey`. A variable exported in the user's shell startup file is found even
  if your own shell did not load it.
- A route's members must speak the same protocol as the client: there is no protocol translation.
- List what the agent needs on the local network or on this machine in `sandbox.allowHosts`. An IP
  needs a port.
- Leave `airs` out if the user has no AIRS account.
- If a model's template spells a switch differently, add
  `"renameTemplateKwargs": { "thinking": "enable_thinking" }` to that upstream.

**4. Check it.**

```sh
rontye status
```

Every line must start with `ok` or `--`. `FAIL` means fix it first. Exit code 1 means a problem. An
unreachable upstream in a route is reported with `--`, because that is what a route is for, so tell
the user about it anyway. After editing the config, run `rontye stop`. The next `rontye run` starts
the gateway with the new config.

**5. Point the agent at the gateway.** Set its base URL to `http://127.0.0.1:4180/v1` and its model
to the route name, `auto`. Its API key can be any string: the gateway substitutes the real one, so
remove real keys from the agent's config if the user agrees. Declare the context window and output
limit of the **smallest** model in the route, or a failover can overflow it.

**6. Run the agent inside the sandbox, and verify.**

```sh
rontye run -- <the agent's command>
rontye log
```

`rontye log` should show `model` or `tool` lines for the agent's work. Then give the user the exact
command to start the agent from now on. Anything started without `rontye run` is not sandboxed.

### Agents

| Agent | Where its models are | How to run it | Tested |
|---|---|---|---|
| DeepSeek Harness | `~/.dsh/profiles/<profile>/cordis.patch.yml`, under `llm-pi-ai` and `agent-default-model` | `DSH_PERMISSION_MODE=danger-full-access rontye run --allow-local-bind -- dsh web` | yes |
| Claude Code | not routed: its API is Anthropic's | `rontye run -- claude` | sandbox only |
| Anything using the OpenAI SDK | `OPENAI_BASE_URL` | `OPENAI_BASE_URL=http://127.0.0.1:4180/v1 rontye run -- <command>` | with `curl` and Node only |

A harness's own sandbox cannot start inside this one on macOS, so turn it off when running under
Ron. For DeepSeek Harness that is the `DSH_PERMISSION_MODE` above. It also turns off that harness's
approval prompts, and applies to that launch only.

### When something fails

| You see | Cause | Do this |
|---|---|---|
| `Operation not permitted` on a file | the write or read is outside the sandbox policy | `--allow-write <path>` or `--allow-read <path>`, if the user agrees |
| HTTP 403 from a local address | this machine and metadata endpoints are refused by default | add `host:port` to `sandbox.allowHosts` |
| `address already in use`, or a web UI will not start | the agent needs to listen | `--allow-local-bind` |
| `sandbox_apply: Operation not permitted` | the agent's own sandbox tried to nest | turn that sandbox off, see above |
| `every upstream failed` | no upstream answered | the 502 body names each failure; check `rontye status` |

## What it does

- **Gateway.** One base URL, `http://127.0.0.1:4180/v1`, for OpenAI Chat, OpenAI Responses and
  Anthropic Messages. Keys stay in the gateway process. The gateway listens on loopback only.
- **Failover.** Tries a route's members in order, and moves on for a refused connection, a timeout,
  HTTP 401, 403, 404, 408, 429 or 5xx, or a stream that dies before its first byte. A failed upstream
  is skipped for 30 seconds, then the first choice is tried again. A 400 goes back to the client,
  since another model would refuse it too. The `x-rontye-upstream` response header names who answered.
- **Firewall.** Every connection from the sandbox goes through a local proxy that terminates TLS,
  and is recorded. This machine and cloud metadata endpoints are refused in every mode. `--enforce`
  denies every host you did not allow.
- **Sandbox.** The agent's whole process tree can only reach the network through that proxy, cannot
  read `~/.ssh`, `~/.aws`, `.env` and other credential locations, and can only write to the project,
  temp and agent state directories. Direct connections fail, even with `curl --noproxy '*'`.
- **Said vs did.** Compares the destinations named in tool calls with the connections made, and
  reports the rest as `FINDING`. A model that fetches a script from a trusted host and uploads your
  keys somewhere else passes any allowlist, but not this.
- **AIRS, enforced.** With `airs` configured, every model call is judged inline and the verdict is
  carried out. A refused request never reaches the model. Secrets are replaced before the model sees
  them and restored on the way back. A streamed reply goes through AIRS: tool calls wait for the
  verdict, and a refused one never reaches the agent, which gets an explanation it can act on. The
  workspace's mode decides whether AIRS refuses (`enforce`) or only records (`observe`).
- **Tool calls tied to what they did.** Each connection and refused file is tied to the tool call
  open at that moment, and sent to AIRS with the next step: `call_1` named `github.com`, and also
  POSTed 40 KB to a host it never mentioned.

## What it does not do yet

- **Judging costs time.** Every model call waits for AIRS first, and if the workspace masks PII in
  output, AIRS holds the whole reply until it is judged, so nothing streams live.
- **With no verdict, traffic passes by default.** Set `"failMode": "closed"` under `airs` to refuse
  instead. A refusal for that reason answers 503 with `x-rontye-verdict: fail-closed`, so it does not
  look like policy.
- **Exec evidence informs and does not decide.** It reaches the console as the sensor's word. No
  guardrail reads it yet. An AIRS older than 1.11 refuses the field, so Ron drops it, and the evidence
  stays in `gateway.ndjson`. Activity after the last model call has no event to ride on.
- **Parallel tool calls share what happened.** Ron does not guess which one did it.
- **A cut stream cannot be switched.** Once bytes have reached the client, a failure ends that
  response. The client's retry goes to the next upstream.
- **`--allow-local-bind` opens every local port on macOS,** not just the agent's own, including a
  browser's debugging port if one is open. Without it, only the gateway's port is reachable directly.
- **On Linux, an agent that refuses to proxy loopback addresses cannot reach the gateway.** DeepSeek
  Harness is one. Clients that honour `HTTP_PROXY` work.
- **Clients that do not resend history hide their calls.** Claude Code 2.1 is one, and a run containing
  it reports `UNVERIFIED` rather than `FINDING`.
- **Connections are attributed to the run, not to a subagent.**
- **Denied file reads are recorded on macOS only.** On Linux they fail and leave no record.
- **The credential list is a starting point.** A key at an unlisted path stays readable.

Records are in `~/.rontye/`: `runs/` for each sandboxed run and `gateway.ndjson` for the gateway, both
mode 0600. They hold destinations, tool names, refused paths and verdicts, and never a body, a query string, a
tool argument or a key. Agents cannot read this directory, your shell startup files or the key
variables named in the config.

## What it is built on

[`@anthropic-ai/sandbox-runtime`](https://github.com/anthropics/sandbox-runtime) does the enforcing:
Seatbelt on macOS, bubblewrap and seccomp on Linux. It is a beta, so the version is pinned, and its
stated limits apply, including domain fronting. Windows is untested.

This repository used to be OpenAFW, which remains in the git history and under tags up to `v1.0.0`.

## Licence

Apache-2.0.
