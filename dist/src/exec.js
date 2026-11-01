const covers = (known, host) => host === known || host.endsWith(`.${known}`);
const hostOf = (target) => target.replace(/:\d+$/, "").replace(/^\[|\]$/g, "").toLowerCase();
export class ExecTracker {
    maxItems;
    openTtlMs;
    retainMs;
    calls = new Map();
    pending = new Map();
    constructor(maxItems = 200, 
    /** A call whose result never comes, because it was refused or abandoned, stops collecting. */
    openTtlMs = 600_000, 
    /** How long a closed call can still claim an observation that reports late. */
    retainMs = 300_000) {
        this.maxItems = maxItems;
        this.openTtlMs = openTtlMs;
        this.retainMs = retainMs;
    }
    open(calls, t) {
        for (const call of calls) {
            if (!this.calls.has(call.id))
                this.calls.set(call.id, { id: call.id, hosts: call.hosts, openedAt: t });
        }
    }
    close(ids, t) {
        for (const id of ids) {
            const call = this.calls.get(id);
            if (call && call.closedAt === undefined)
                call.closedAt = t;
        }
        for (const [id, call] of this.calls) {
            if (t - (call.closedAt ?? call.openedAt) > this.retainMs + (call.closedAt === undefined ? this.openTtlMs : 0))
                this.calls.delete(id);
        }
    }
    windowOf(t) {
        return [...this.calls.values()].filter((call) => call.openedAt <= t && t <= (call.closedAt ?? call.openedAt + this.openTtlMs));
    }
    observe(observation) {
        const window = this.windowOf(observation.t);
        const callIds = window.map((call) => call.id).sort();
        const undeclared = observation.kind === "network" && window.length > 0 && !window.some((call) => call.hosts.some((host) => covers(host, hostOf(observation.target)) || covers(hostOf(observation.target), host)));
        const key = JSON.stringify([observation.kind, observation.target, observation.action, observation.denied, callIds]);
        const item = this.pending.get(key) ?? {
            kind: observation.kind,
            target: observation.target,
            ...(observation.action ? { action: observation.action } : {}),
            ...(observation.denied ? { denied: true } : {}),
            count: 0,
            call_ids: callIds,
            ...(undeclared ? { undeclared: true } : {}),
        };
        item.count += 1;
        if (observation.bytes)
            item.bytes_up = (item.bytes_up ?? 0) + observation.bytes;
        this.pending.set(key, item);
        return item;
    }
    /** What has been seen since the last report, the most telling first, since the cap cuts the rest. */
    drain() {
        if (this.pending.size === 0)
            return undefined;
        const rank = (item) => (item.denied ? 0 : item.undeclared ? 1 : item.call_ids.length > 0 ? 2 : 3);
        const all = [...this.pending.values()].sort((a, b) => rank(a) - rank(b));
        this.pending = new Map();
        const items = all.slice(0, this.maxItems);
        return { items, ...(all.length > items.length ? { dropped: all.length - items.length } : {}) };
    }
}
/** A macOS sandbox line as an observation, or null for what says nothing about the agent's work. */
export function fileObservation(line, t) {
    const match = /^(\S+?)\(\d+\) deny\(\d+\) file-(read-data|write-\S+) (.+)$/.exec(line);
    if (!match)
        return null;
    return { t, kind: "file", target: match[3], action: match[2] === "read-data" ? "read" : "write", denied: true, process: match[1] };
}
