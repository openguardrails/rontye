# Changelog

## 0.2.0

Adds the gateway: one local base URL in front of many model APIs, with ordered failover, keys held
outside the agents, and both halves of each call sent to AIRS. Adds `rontye status`, `serve` and
`stop`, and `~/.rontye/config.json`. This machine and metadata endpoints are now refused in every
mode. The README is written for agents to follow.

## 0.1.0

A new program, replacing OpenAFW in this repository. `rontye run` starts a command in an OS sandbox,
records its network activity and model calls, denies credential files, and compares the destinations
tool calls named with the connections made. OpenAFW remains in the history and under tags up to `v1.0.0`.
