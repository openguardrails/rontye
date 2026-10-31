/** ~/.rontye/config.json: the upstreams, the routes, the AIRS connection and sandbox defaults. */
import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
export const rontyeHome = () => process.env.RONTYE_HOME ?? join(homedir(), ".rontye");
export const configPath = () => join(rontyeHome(), "config.json");
export const DEFAULT_PORT = 4180;
export function loadConfig() {
    const path = configPath();
    if (!existsSync(path))
        return {};
    const config = JSON.parse(readFileSync(path, "utf8"));
    return validate(config);
}
/** Refuses a broken config: a typo here must not become traffic that only looks routed. */
export function validate(config) {
    const gateway = config.gateway;
    if (!gateway)
        return config;
    for (const [name, upstream] of Object.entries(gateway.upstreams ?? {})) {
        if (!upstream.baseURL || !upstream.model)
            throw new Error(`config: upstream "${name}" needs baseURL and model`);
        new URL(upstream.baseURL);
    }
    for (const [name, members] of Object.entries(gateway.routes ?? {})) {
        if (members.length === 0)
            throw new Error(`config: route "${name}" is empty`);
        for (const member of members) {
            if (!gateway.upstreams?.[member])
                throw new Error(`config: route "${name}" names unknown upstream "${member}"`);
        }
    }
    return config;
}
export function secretOf(holder, env = process.env) {
    return (holder.apiKeyEnv ? env[holder.apiKeyEnv] : undefined) ?? holder.apiKey;
}
/** A readable config file with a key in it is the leak this tool exists to prevent. */
export function looseConfigWarning(config) {
    const inline = config.airs?.apiKey || Object.values(config.gateway?.upstreams ?? {}).some((upstream) => upstream.apiKey);
    if (!inline || process.platform === "win32")
        return null;
    return (statSync(configPath()).mode & 0o077) === 0 ? null : `${configPath()} holds keys and is readable by others. Run: chmod 600 ${configPath()}`;
}
/** The upstreams to try for a requested model: a route, one upstream by name, or null. */
export function resolveRoute(gateway, model) {
    if (typeof model !== "string")
        return null;
    if (gateway.routes?.[model])
        return gateway.routes[model];
    return gateway.upstreams[model] ? [model] : null;
}
