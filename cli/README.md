# nhxcli — libneonethack JSON-lines bridge

One process owns any number of sessions. It is the reference binding:
every other surface (MCP, browser) should forward to this protocol rather
than reimplementing world semantics.

Build:

```sh
cc -Wall -Wextra -Ilib -o /tmp/nhxcli cli/nhxcli.c \
  lib/session.c lib/minjson.c lib/explorer.c
```

Run:

```sh
nhxcli <engine_bin> <template_dir> <sessions_dir>
```

Protocol: one JSON object per line on stdin, one response envelope per
line on stdout. Requests are exactly the `nhx_call` tools:

- `{"tool":"new_game","name":..,"seed":..,"role":..,"race":..,
  "gender":..,"align":..}` — roles/races/etc. as English names.
- `{"tool":"act","sessionId":..,"action":"move","direction":"south"}`
- `{"tool":"act","sessionId":..,"replyTo":"decision-3","item":{"id":"item-a"}}`
- `{"tool":"get_state","sessionId":..}`
- `{"tool":"resume","sessionId":..}`
- `{"tool":"end_session","sessionId":..}`
- `{"tool":"shutdown"}` — exit 0 (EOF also exits).

Responses are the API_DESING.md envelopes
(`outcome`/`observation`/`events`/`decision`/`ended`, plus `error`
for rejections). After a reconnect, call `resume` before `act`: sessions
persist on disk, engines do not.

Notes for binding implementers:

- Serialize calls: the bridge answers in request order; one in flight
  at a time (see `mcp/src/core.ts`).
- The resting engine prompt arrives as `poskey` (core `readchar`
  funnels every key read through `nh_poskey`); answer with `{"key":N}`.
- Direction questions arrive as bare `yn` ("In what direction?") with
  empty choices; item-letter prompts look like "What do you want to
  eat?". Accelerator presence (`accel > 0`), not glyphs, marks a menu
  row selectable; menu-item glyphs arrive as objects, map glyphs as
  numbers.
- `NETHACKOPTIONS` defaults to `!tutorial,time` when unset, matching
  the MCP server.
