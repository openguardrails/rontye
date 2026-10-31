/** What the model said it would reach, against what the process tree actually reached. */
/** Hosts a tool call reaches without naming them: package registries and harness telemetry. */
const EXPECTED = [
    "registry.npmjs.org", "pypi.org", "files.pythonhosted.org", "crates.io", "static.crates.io",
    "index.crates.io", "proxy.golang.org", "sum.golang.org", "objects.githubusercontent.com",
    "statsig.anthropic.com", "statsig.com", "sentry.io", "datadoghq.com", "featuregates.org",
];
const covers = (known, host) => host === known || host.endsWith(`.${known}`);
export class Correlator {
    declared = new Set();
    modelHosts = new Set();
    seen = new Map();
    reported = new Set();
    /** The vendor's other hosts count too: api.anthropic.com brings mcp-proxy.anthropic.com. */
    noteModelHost(host) {
        this.modelHosts.add(host);
        const labels = host.split(".");
        if (labels.length >= 3 && !/^[\d.]+$/.test(host))
            this.modelHosts.add(labels.slice(1).join("."));
    }
    noteDeclared(hosts) {
        for (const host of hosts)
            this.declared.add(host);
    }
    noteConnection(host, method, bytesUp, now) {
        const entry = this.seen.get(host) ?? { methods: new Set(), requests: 0, bytesUp: 0, last: now };
        entry.methods.add(method);
        entry.requests += 1;
        entry.bytesUp += bytesUp;
        entry.last = now;
        this.seen.set(host, entry);
    }
    /**
     * A call only becomes visible in the next model request, so a connection cannot be judged when
     * it happens. It waits `graceMs` for the call that names it. `final` judges everything left.
     */
    flush(now, graceMs, final = false) {
        const found = [];
        // With no model call seen, "no tool call named it" would be true of everything and mean nothing.
        if (this.modelHosts.size === 0)
            return found;
        for (const [host, entry] of this.seen) {
            if (this.reported.has(host))
                continue;
            if (!final && now - entry.last < graceMs)
                continue;
            if ([...this.modelHosts].some((known) => covers(known, host)))
                continue;
            if (EXPECTED.some((known) => covers(known, host)))
                continue;
            // Either way round: a call naming github.com reaches api.github.com, and one naming
            // api.github.com may first hit github.com.
            if ([...this.declared].some((known) => covers(known, host) || covers(host, known)))
                continue;
            this.reported.add(host);
            found.push({ host, methods: [...entry.methods].sort(), requests: entry.requests, bytesUp: entry.bytesUp });
        }
        return found;
    }
}
