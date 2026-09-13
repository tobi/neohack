# Pi in the browser

Run from this checkout with Bun, a configured Pi CLI and agent-browser with
sandboxed Chrome installed:

```sh
bun examples/pi-webmcp/run.mjs --check
bun examples/pi-webmcp/run.mjs --check-pi
bun examples/pi-webmcp/run.mjs --minutes 60 --headed
```

`agent-browser.toml` selects the website and model. The launcher discovers the
page's actual schemas; the hosted page must expose the current `create`,
`syncState` and `help` vocabulary. `--check` reads discovery and help without
creating a game. `--check-pi` also verifies Pi file reading/writing, exposing only
WebMCP help. `--headed` requires a display; omit it for a headless browser.

Normal play exposes all discovered WebMCP tools plus Pi's `read_file` and
`write_file`. These names avoid a collision with NetHack's `read` action.
The extension uses Pi's own SDK, not another installed copy. Shell, editing and
general browser-evaluation tools are disabled. File access is not an OS sandbox.

Each invocation retains a new private output directory with the browser profile,
Pi transcript and exact invocation logs. `--output` selects a new directory.
Keep these files private: they can contain run access tokens. The launcher stops
at its deadline or interruption and closes its browser. It never automatically
restarts an uncertain action. See [agent play](../../lib/neonethack/docs/AGENT_PLAY.md)
for decisions, navigation and recovery boundaries.
