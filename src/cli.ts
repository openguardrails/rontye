#!/usr/bin/env node
import { latestRun, readRun, renderEvent } from "./record.js";
import { run } from "./run.js";

const USAGE = `rontye: a firewall for the agents your agents spawn

  rontye run [options] -- <command...>   run a command and everything it spawns inside the firewall
  rontye log [run-id]                    print what a run did (default: the latest)

run options:
  --enforce              deny every host not allowed, instead of recording it
  --allow-host <host>    allow a host; an IP needs a port (--allow-host 127.0.0.1:8000)
  --deny-host <host>     deny a host in every mode
  --allow-read <path>    re-open a credential path that is denied by default
  --allow-write <path>   allow writes outside the project, temp and agent state directories

environment:
  OGR_API_KEY            send model requests to OpenGuardrails AIRS for judging (observe only)
  OGR_RUNTIME_URL        the AIRS address
  OGR_AGENT_ID           the agent id to report (default: the harness name)
`;

function parseRun(args: string[]) {
  const options = { enforce: false, allowHosts: [] as string[], denyHosts: [] as string[], allowRead: [] as string[], allowWrite: [] as string[], command: [] as string[] };
  const lists: Record<string, string[]> = {
    "--allow-host": options.allowHosts,
    "--deny-host": options.denyHosts,
    "--allow-read": options.allowRead,
    "--allow-write": options.allowWrite,
  };
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!;
    if (arg === "--") {
      options.command = args.slice(i + 1);
      break;
    }
    if (arg === "--enforce") {
      options.enforce = true;
      continue;
    }
    const list = lists[arg];
    const value = args[i + 1];
    if (!list || value === undefined) throw new Error(`unknown or incomplete option: ${arg}`);
    list.push(value);
    i += 1;
  }
  if (options.command.length === 0) throw new Error("nothing to run: rontye run -- <command...>");
  return options;
}

async function main(argv: string[]): Promise<number> {
  const [verb, ...rest] = argv;
  if (verb === "run") return run(parseRun(rest));
  if (verb === "log") {
    const runId = rest[0] ?? latestRun();
    if (!runId) throw new Error("no runs recorded yet");
    for (const event of readRun(runId)) console.log(renderEvent(event));
    return 0;
  }
  process.stdout.write(USAGE);
  return verb && verb !== "help" && verb !== "--help" ? 2 : 0;
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (error) => {
    // Refusing is the rule: a command that starts without the firewall only looks protected.
    process.stderr.write(`[rontye] ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  },
);
