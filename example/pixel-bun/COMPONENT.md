# Embedding and the ascender workshop

Build with `bun run build`. `/component/neohack.js` is a single ESM bundle with
its selected runtime PNG artwork and shadow-root styles included. No framework,
global CSS, game worker or account is required to display a public snapshot.
The HTML tag can be used on another origin; the module route serves CORS headers.
NetHack and character-art notices remain applicable. The licensed character art
is for project use; embedding does not grant redistribution rights to the raw
artwork. See [asset terms](art/ATTRIBUTION.md).

```html
<script type="module" src="https://neohack.dev/component/neohack.js"></script>
<neohack-world id="world" role="valkyrie" seed="42"></neohack-world>
```

```js
import Nethack, { Game, tools } from '/component/neohack.js';
const world = document.querySelector('#world');
await customElements.whenDefined('neohack-world');
world.snapshot = game.state; // a public library Snapshot
world.addEventListener('frame', event => console.log(event.detail));
world.loadReplay(recordedFrames);
world.seek(0);
world.play(250); // milliseconds per recorded frame, minimum 50
world.pause();
```

`role` chooses the existing character art, `seed` controls the existing deterministic
surface treatment, and `static` hides the text-observation disclosure. Set attributes
before supplying a frame. The component has no keyboard or pointer game controls.
Its container determines its size (minimum height 320px). Removing it pauses playback
and disposes renderer listeners; reattaching it renders its retained frame.

To connect a runtime you own, call `world.connect(transport, { writable: true })`.
This returns the public `Neonethack` client with unchanged `create`, `resume` and
`Game` methods, request identifiers and uncertainty behavior. Every returned snapshot
updates the viewer. Without `writable: true`, only catalog read-only methods are
allowed. Closing the returned client detaches the connection; the host still owns
and closes its underlying transport and durable store. No automatic engine loading,
upgrade, warning confirmation or retry is performed by the viewer.

`postMessage()` accepts JSON-RPC 2.0 `{ jsonrpc, id, method, params }`, returns a
promise for the response envelope, and emits that envelope as `MessageEvent.data`
on the element. It never listens to `window.message`. A host bridging an iframe
must validate that iframe's origin and source before forwarding messages.

| Method | Parameters |
| --- | --- |
| `tools/list` | none; returns generated schemas for this connection |
| `tools/call` | `{name, arguments}`; unchanged named engine operation |
| `world.snapshot` | none; reads the last displayed snapshot |
| `world.render` | `{snapshot}`; presentation only |
| `replay.load` | `{frames}` |
| `replay.seek` | `{index}` |
| `replay.play` | `{interval}` (optional, default 250 ms) |
| `replay.pause` | none |

Without a transport, tool discovery returns an empty list. `tools/call` returns
MCP text content plus `structuredContent`; explicit engine errors set `isError`.
Bridge validation failures return a JSON-RPC error and never retry a request.
`registerWebMcp(context?)` registers only the current connection's allowed tools;
retain its returned registration and call `dispose()` before replacing a connection
or removing its host. It reports unsupported browsers without installing a shim.

## Accounts and recordings

The full account API runs in the Cloudflare worker (`Accounts` Durable Object).
The local Bun server serves static files only; use Wrangler for account testing.
Passkeys need HTTPS in production or a `localhost` hostname for local development.
WebAuthn verification uses SimpleWebAuthn (MIT), with discoverable credentials,
required user verification, one-use five-minute challenges, credential counters,
unique case-insensitive handles and HttpOnly SameSite=Strict sessions. Cross-origin
writes are rejected. The browser controls the phone/QR ceremony; the site never
manufactures its own authentication QR code. See the [SimpleWebAuthn documentation](https://simplewebauthn.dev/docs/packages/server/).

Signed-in live games and tests upload a separate private observation recording.
These records are browser reports, not authoritative scores or resumable engine
journals. Replays do not load WASM. Optional `observation.neighborhood` action-query
expansions are omitted from the presentation recording; world cells, vitals,
inventory, decisions and events remain. Frames are appended with an exact index,
increasing revision, session identity and immutable engine package ID. Failed or
uncertain uploads stop this recorder visibly; they never cause new engine input.
A resumed game starts a new partial recording. Existing anonymous journals are not
silently claimed or converted. Signing in from the shared top rail updates the current page without navigation.
Changing accounts stops an active replay recorder before it can upload to a new account.

Recordings explicitly carry `control: "bot" | "interactive"`. Interactive sessions
can also share control with WebMCP; the label does not attest to human authorship.
Bot recordings retain their definition's name and immutable source separately from
the editable saved project. Before initialization, the first frame and source are
saved atomically. Source contains original and compiled files, the TypeScript
version, entrypoint and construction autoloot settings. If that save fails, the
bot does not initialize. Anonymous tests remain temporary.

`GET /api/account/runs/:id/source` returns the owner-only `{artifact, sha256}`:
`artifact` is the exact stored JSON string, with a SHA-256 of its UTF-8 bytes.
Later frame appends cannot replace source or change run identity. Account history
provides a source viewer and download alongside the read-only replay.

## Workshop

`/bots` uses CodeMirror (MIT) and TypeScript (Apache-2.0). The named entrypoint is `main.ts`, exporting `defineBot({ name: "My bot", autoloot: rules, initialize({ hero, game, log }) { ... } })`. It registers observation listeners and a single awaited `turn` listener. The two-file imp starter demonstrates exploration, retreat, eating and new equipment. The name is required; optional construction `autoloot` uses the engine’s `AutomaticPickup` schema and is applied through a journaled, zero-turn configuration before initialization. Containers remain explicit.
TypeScript provides live cross-file completions, hover docs and advisory diagnostics; Test transpiles the project. The `neonethack` import exposes Hero, direction and entity enums alongside the same
client classes; arbitrary package imports are unavailable.

The parent owns a fresh volatile engine and validates every brokered request against
its one session. Source executes in a dedicated worker inside an opaque sandboxed
iframe, with network connections disallowed by CSP. Only the sandbox permits dynamic
code compilation. A private MessagePort carries requests and bounded logs. Tests
stop after 1,000 calls or five minutes. Stop removes the sandbox immediately,
then settles submitted engine work and queued recordings before closing the engine.
No receipt failure authorizes replacement input. These are local experiments, not
a server-side compute or verified competition service.

Run actual passkey, isolated-script, engine and replay integration checks with:

```sh
bun run --cwd example/pixel-bun build
node hosting/cloudflare/scripts/stage.mjs
node --test hosting/cloudflare/tests/studio.test.mjs
```

The workshop defaults to random class and seed, sampled once when starting a test.
Choose a specific class or fixed seed to reproduce a setup. Saved projects retain
the selected mode; replay records retain the actual class and seed. The desktop IDE
has a file explorer, tabs, a keyboard-resizable divider and output panel. Ctrl/⌘ S
saves; Ctrl/⌘ Enter runs. The API budget is fixed at 1,000 and has no form control.
The workshop requires Web Crypto (HTTPS or localhost) to verify runtime assets.
An insecure address is explained before any runtime is loaded.

See the [typed Hero API](../../lib/neonethack/docs/HERO.md) for sensing, movement,
melee and inventory conveniences. Its declarations drive the workshop editor.
