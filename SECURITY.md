# Security

neonethack is an alpha with a live website, not a security-audited service. There is no
stable supported release line or promised response time yet.

## Reporting a vulnerability

Do not put exploit details, credentials, player journals or private engine pins
in a public issue. Use the repository's **Security → Report a vulnerability**
action when private reporting is enabled. If it is unavailable, ask the repository
owner for a private reporting channel without disclosing the vulnerability.

Include the affected source revision/package identity, platform, minimal
reproduction using a **new temporary store**, and expected versus actual behavior.
Do not send live player stores. Coordinate disclosure privately with the owner.

## Trust boundaries

- Native engine executables, static data, game stores and build toolchains are
  trusted local resources. The C library and CLI are not a sandbox for hostile
  binaries or saves. Native C calls must not change the host's signal handlers.
- The library is not an authentication or multi-tenant authorization layer.
  Applications exposing MCP or other transports must supply their own access
  controls. Example servers are loopback development tools, not hardened public
  hosting configurations.
- The browser requires a secure context and explicit storage ownership. Web Locks
  and IndexedDB protect the supported single-owner workflow; they do not defend
  against malicious code running in the same origin or a compromised browser.
- Archive auditing checks structure, hashes and provenance, then **executes**
  included binaries/build recipes. Only audit trusted local previews; a checksum
  is not authentication and the auditor is not an OS sandbox.
- Lost replies, missing receipts and corrupt state fail closed. Do not retry a
  potentially executed request under a new ID, silently repair a journal or
  replace its engine to make recovery succeed.

See the [protocol](lib/neonethack/docs/PROTOCOL.md),
[WASM storage contract](lib/neonethack/docs/WASM.md),
[replay limits](lib/neonethack/docs/REPLAY.md) and
[distribution guide](lib/neonethack/docs/DISTRIBUTION.md) for the exact guarantees.
