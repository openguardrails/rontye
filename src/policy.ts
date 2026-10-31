/** What a run may touch, as sandbox-runtime configuration. */
import { realpathSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { SandboxRuntimeConfig } from "@anthropic-ai/sandbox-runtime";

export interface PolicyOptions {
  cwd: string;
  allowHosts: string[];
  denyHosts: string[];
  allowRead: string[];
  allowWrite: string[];
}

/** Where credentials live. A starting point rather than a boundary: an unlisted path stays readable. */
const CREDENTIAL_PATHS = [
  ".ssh", ".aws", ".azure", ".oci", ".kube", ".gnupg", ".config/gcloud", ".config/gh",
  ".docker/config.json", ".netrc", ".npmrc", ".pypirc", ".pgpass", ".git-credentials", ".boto", ".my.cnf",
];

/** Where the agents this is built for keep their own state; without these they fail to start. */
const AGENT_STATE_PATHS = [
  ".claude", ".claude.json", ".codex", ".gemini", ".pi", ".hermes", ".openclaw", ".aider",
  ".config/opencode", ".local/share/opencode", ".local/state", ".cache", ".npm", ".bun", "Library/Caches",
];

/** macOS /tmp is a symlink, and sandbox-runtime silently drops a symlink that short as out of bounds. */
const real = (path: string) => {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
};

export function buildPolicy(options: PolicyOptions): SandboxRuntimeConfig {
  const home = homedir();
  const inHome = (path: string) => join(home, path);
  return {
    network: {
      // Empty on purpose: every other host reaches the ask callback, which is where a run in
      // observe mode lets it through and writes it down.
      allowedDomains: options.allowHosts,
      deniedDomains: options.denyHosts,
    },
    filesystem: {
      denyRead: [
        ...CREDENTIAL_PATHS.map(inHome),
        join(options.cwd, "**/.env"),
        join(options.cwd, "**/.env.*"),
      ],
      allowRead: options.allowRead,
      allowWrite: [options.cwd, real(tmpdir()), real("/tmp"), ...AGENT_STATE_PATHS.map(inHome), ...options.allowWrite],
      denyWrite: [],
    },
  };
}
