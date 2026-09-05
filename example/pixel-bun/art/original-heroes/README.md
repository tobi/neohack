# Original hero pilot

The user selected three independent original fantasy designs generated using
the **built-in image_gen tool**, with no vendor sprite input. The tool did not
expose a model version or seed. Preserve all ten source files here: this README,
three prompts, three untouched generated source PNGs and three editable JSON
frame recipes. These are original project inputs, not copied skill templates.

| Character | Exact prompt | Untouched source | Editable native frames |
| --- | --- | --- | --- |
| Valkyrie | [Prompt](valkyrie-prompt.txt) | [Generated sheet](valkyrie-source.png) | [Pixel grids](valkyrie.json) |
| Wizard | [Prompt](wizard-prompt.txt) | [Generated sheet](wizard-source.png) | [Pixel grids](wizard.json) |
| Ranger | [Prompt](ranger-prompt.txt) | [Generated sheet](ranger-source.png) | [Pixel grids](ranger.json) |

The prompts requested a 16×32 logical pixel grid. Actual generation returned
887×1774 source images; it did not satisfy exact native grid geometry. A 16px-wide
trial lost the shoulder, hat and cloak shapes. The selected game frames are
24×32, with a bottom-center (12,32) pivot on the unchanged 16px ground grid.

`../../scripts/import-original-heroes.mjs` extracts fixed cells, reduces them,
thresholds alpha, maps a shared 27-color palette and applies one vertical
registration per clip. No walking pose is resized or registered independently.
Idle holds the first directional drawing; walking retains six generated poses.
The JSON records all transformations and is editable. Re-importing intentionally
replaces grid edits, so use `../../scripts/build-original-heroes.mjs` for ordinary
PNG rebuilds. That build does not call image_gen or need the private asset skill.

Only final game PNGs live in `../../public/art/`, under `valkyrie-original`,
`wizard-original` and `ranger-original`. There are no public JSON sidecars;
portable source hashes and frame parameters remain in the editable recipes here
and the export selections in [../recipe.json](../recipe.json). Each packed sheet
is 576×64: right/up/left/down groups of six frames, idle above walking. Display
at integer scale with smoothing off. Portraits retain the native aspect ratio.

From the example root, `node --test tests/assets.test.mjs` checks the source
inventory, source-image hashes, prompts, frame geometry and runtime selection.
The separate browser suite exercises directional rendering, actual engine
creation, layer order, reduced motion and mobile. Inventory/provenance checks
are not visual or player-recognition validation or a promise of naturalistic gait.
Comparison reports and obsolete character exports are not part of this source.

These three designs establish the family; the other ten playable classes retain
their prototype art. Publication and licensing remain the owner's decision.
