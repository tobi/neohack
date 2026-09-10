# Text rendering review

Reviewed September 10, 2026. Treat player, script, account, engine-message and
model text as data. Preserve literal text in storage and protocol requests;
encode at HTML output, not when recording an action. This is a source/sink review
with browser regressions, not a claim of formal proof or a penetration test.

| Input or stored text | Rendering boundary |
| --- | --- |
| Hero creation | Generated-only website, WebMCP and workshop names; public metadata accepts the generated vocabulary. Operator corrections cannot be supplied in uploads. |
| In-game text answers, inscriptions and item nicknames | Native input `.value`; messages and decision labels use `textContent`/text nodes. Item/HUD HTML interpolations escape labels and attributes. Naming an item remains a game operation. |
| Action search and item choices | Lit text/property bindings. Substring/fuzzy matches do not become HTML. |
| Journal messages, repeats and turn labels | Text nodes, including turn values from stored data. Scroll text is not interpreted as markup. |
| Automatic pickup patterns | Textarea `.value`, literal substring matching, text-only summaries. |
| Encyclopedia queries and entries | Input `.value`, text-only names and paragraphs; no HTML from engine lore. |
| Account names and service errors | Text-only account/rail labels. Signup separately validates account handles. Server messages never become HTML. |
| Script names, files, source, state, controls and notes | Input properties, CodeMirror documents and text nodes. User code executes intentionally inside the isolated worker/sandbox, not as host-page HTML. |
| Ledger names, roles, outcomes, harness/model badges | DOM text/attribute properties; constant SVG icon markup. Replay IDs are validated/encoded when building URLs. |
| Replay observations and read-only transcript | `textContent`. Name corrections affect displayed text only; snapshot objects and exact receipts remain original. |
| Chronicle drafts, final paragraphs, glossary and metadata | DOM text nodes. Optional replay links accept only HTTP(S) without credentials. Standalone HTML exports escape prose, attributes and numeric-looking evidence fields. |

The review replaced journal turn-label HTML assembly and escaped remaining
numeric-looking values in welcome/death copy and the standalone chronicle export.
Fixed template/icon markup remains HTML; user values must never enter it raw.
Image URLs come from the approved asset map or generated canvas data URLs.

Regressions live in `tests/browser.test.mjs`,
`hosting/vercel/tests/{text-rendering,run-names,blob,dashboard-records}.test.mjs`
and `examples/chronicle/{chronicle,lore}.test.mjs`. They exercise malicious tags,
quotes and event attributes as literal text, generated-name enforcement, unsafe
link schemes, persistent operator corrections and unchanged replay descriptors.
