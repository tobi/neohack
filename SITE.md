# neonethack — site brief

Project name: **neonethack** (Neovim-style headless NetHack + open world API).

The bun front serves a small site alongside the playable client:

1. `/` — About NetHack. What the game is, why its depth is worth preserving,
   why the UI deserves a second life. Written for people who never played.
2. `/what-is-neonethack` — what neonethack is: the world implemented once
   in C (libneonethack), everything a UX needs arrives as deeds in and
   perceptions out, and anyone can build a client in any stack.
3. `/protocol` — the world API in five minutes: lifecycle, reply shape
   (outcome/events/observation/decision), resume. Links `/api-docs` (full
   JS API + event catalogue) and the raw engine `proto/PROTOCOL.md`.
4. `/api-docs` — the full JS API + event catalogue, rendered from
   `client/API.md`. The implementor's reference.
5. `/gallery` — example client gallery. Entry #1 is our own reference
   implementation, labeled honestly as the **existence proof**. Every entry:
   screenshot, client stack, API it speaks, author link.
6. Site-wide invitation: **make a better one.** Contribution CTA pointing at
   the world docs + gallery submission path. The reference client is a floor,
   not a ceiling.
