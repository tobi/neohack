# Social artwork

The finished compositions reuse the game's authored doorway, Ranger and dog.
Typography and framing are editable in `composition.html`; the scene comes from
`DungeonMap.drawWelcomeArt`, at frame zero and integer pixel scales.

Run `bun web/neohack.dev/scripts/build-social.ts` from the repository root.
It uses sandboxed Chromium and writes these finished PNGs to `public/social/`:

- `open-graph.png`: 1200 × 630, linked by the page's Open Graph and Twitter metadata.
- `profile-banner.png`: 1500 × 500, with room at left for a profile avatar.
- `stream-overlay.png`: 1920 × 1080, transparent center for gameplay or video.

Output dimensions and checksums are recorded in `public/social/recipe.json`.
These are flattened project compositions; the selected character art remains
credited to LimeZu under the existing [art terms](../ATTRIBUTION.md).
JetBrains Mono uses the bundled [SIL Open Font License](../../public/fonts/OFL.txt).
