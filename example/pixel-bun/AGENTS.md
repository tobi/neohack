# Pixel client

Read [DESIGN.md](DESIGN.md) before visual or interaction changes, and maintain it
as the user's choices develop. This example is a client of the public library API;
all repository boundary, storage, licensing and verification rules still apply.

Keep only the 29 runtime PNGs listed in `art/recipe.json` under `public/art/`:
ten LimeZu prototype portrait/sheet pairs, three original hero pairs and three
animal portraits. Preserve the ten original project source files in
`art/original-heroes/` (README, generated source PNGs, prompts and editable JSON
pixel grids); these are original art inputs, not copied vendor skill assets.
Never copy raw skill templates, vendor pixel grids/layers/full sheets, catalogs
or private tools into source. Keep portable export parameters in the art recipes,
not public JSON sidecars. Do not restore retired prototype exports or review
reports. Preserve the exact art terms and run `node --test tests/assets.test.mjs`
from this example when changing the selection; minimization is not redistribution
permission.
