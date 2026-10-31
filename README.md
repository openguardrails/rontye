# Ron Tye

**A firewall for the agents your agents spawn.**

Claude Code and Codex come with guardrails. The opencode, hermes or pi workers they dispatch, running
a third-party quantization on your own GPU or a model behind a relay, come with none, and you cannot
see what those workers did. Weights can carry a backdoor that evaluations do not catch, and official
weights have been seen reaching for places nobody asked them to go:

- [How abliterated models can get you pwned](https://projectdiscovery.io/research/how-abliterated-models-can-get-you-pwned)
- [Concerning behaviour in a popular open-weight model](https://cohere.com/blog/concerning-behaviour-popular-open-weight-ai-model)

`rontye run` starts a command in an OS sandbox. Its whole process tree, every subagent and script
included, can only reach the network through Ron, and cannot read your credential files.

```sh
npm install && npm run build
node dist/src/cli.js run -- claude
node dist/src/cli.js log
```

```
14:10:05 model    opencode -> 127.0.0.1 qwen3.8-27b-q4 (openai.chat)
14:10:05 tool     shell  names example.org
14:10:06 FINDING  undeclared destination example.com: POST x1, 6B up, no tool call named it
```

A model that fetches a script from a trusted host and uploads your keys somewhere else passes any
allowlist. The signal is the gap between where the tool calls said they were going and where the
process tree actually went.

## What it does

| | |
|---|---|
| **Network** | Every connection goes through a local proxy that terminates TLS. Direct connections fail, even with `curl --noproxy '*'`. Cloud metadata and loopback addresses are refused unless you allow them. |
| **Files** | `~/.ssh`, `~/.aws`, `.env` and other credential locations cannot be read. Writes are limited to the project, temp and agent state directories. |
| **Model calls** | Recognised by path on any host, so a local vLLM, OpenRouter and a relay all count. Records which agent called which model on which host. |
| **Said vs did** | Compares the destinations named in tool calls with the connections actually made. |
| **Modes** | Network is observed by default. `--enforce` denies every host you did not allow. File rules always apply. |

A local model needs its address allowed: `rontye run --allow-host 127.0.0.1:8000 -- opencode`.

The record is in `~/.rontye/runs/`, mode 0600. It holds destinations and tool names, and never a
body, a query string, a tool argument or a long path segment.

With `OGR_API_KEY` set, each model request also goes to [OpenGuardrails AIRS](https://openguardrails.com)
for judging. That sends the request body as it is, secrets included, and it only records: a verdict
stops nothing yet.

## What it does not do yet

- **It cannot read a model's reply.** The proxy hook exposes a reply's status and headers only. Tool
  calls are read from the next request's history, so they are seen after they ran, and nothing can
  stop a tool call before it runs.
- **Claude Code 2.1 does not resend its history.** Its calls are invisible, so a run containing it
  reports `UNVERIFIED` instead of `FINDING`. A run in which every client resends history, as
  stateless chat completion clients must, is not affected.
- **Connections are attributed to the run, not to an agent.** Each model call is labelled from its
  User-Agent, which a process can fake. Which subagent opened which connection is unknown.
- **No secret masking, and no live or web view.** `rontye log` prints a finished or running record.
- **Not nested in another sandbox.** macOS refuses to nest `sandbox-exec`, so a harness's own sandbox
  cannot start inside Ron.

Denied file reads are recorded on macOS. On Linux they fail for the process and leave no record.

## What it is built on

[`@anthropic-ai/sandbox-runtime`](https://github.com/anthropics/sandbox-runtime) does the enforcing:
Seatbelt on macOS, bubblewrap and seccomp on Linux. It is a beta, so the version is pinned. Windows
is untested here. Its stated limits apply, including domain fronting. Linux needs `bubblewrap`,
`socat` and `ripgrep`, and macOS needs `ripgrep`. Node 22.12 or newer is required.

The credential list is a starting point, not a boundary: a key stored at an unlisted path stays
readable.

## History

This repository used to be OpenAFW. That code remains in the git history and under the tags up to
`v1.0.0`.

## Licence

Apache-2.0.
