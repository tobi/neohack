# Dungeon error pages

Run `node web/neohack.dev/scripts/build-errors.mjs` from the repository root.
The normal web build runs it too. Outputs are `public/400.html`, `404.html`, and
`500.html`, with all styles and artwork embedded so errors need no asset server.

The generator builds stone numerals on a 256×152 pixel grid using the existing
olive/amber dungeon palette. Desktop uses 2× scale and mobile 1×. Portraits reuse
`public/art/valkyrie.png` (LimeZu) and `public/art/dog.png` (original creature);
there are no new vendor exports or additions to the 29-PNG runtime inventory.
Shared typography and layout live in `style.css`. Recovery links work without JS.
