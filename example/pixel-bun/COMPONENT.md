# Embedding the world

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
