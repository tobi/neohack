import { readFile, mkdtemp, rm, copyFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { execFileSync } from 'node:child_process';

// The private source library is a build-time art dependency only.
const pixel = process.env.PIXEL;
if (!pixel) throw Error('Set PIXEL to the pixel-art-interfaces resources/tools/pixel executable.');
const root = resolve(import.meta.dirname, '..');
const recipes = JSON.parse(await readFile(join(root, 'art/classes.json'), 'utf8'));
const temp = await mkdtemp(join(tmpdir(), 'neonethack-characters-'));
const run = (...args) => execFileSync(pixel, args, { stdio: 'pipe' });
try {
  for (const recipe of recipes.characters) {
    if (recipe.asset) {
      for (const [suffix, rect] of [["", [48, 0, 16, 32]], ["-motion", [0, 32, 384, 64]]]) {
        const out = join(temp, recipe.id + suffix + '.png');
        run('export', recipe.asset, '--rect', ...rect.map(String), '--out', out);
        await copyFile(out, join(root, 'public/art/' + recipe.id + suffix + '.png'));
      }
      console.log('Exported ' + recipe.id + ': premade portrait + directional clips');
      continue;
    }
    const sheet = join(temp, `${recipe.id}.png`);
    const args = ['character', '--body', recipe.body, '--eyes', recipe.eyes, '--outfit', recipe.outfit];
    if (recipe.hair) args.push('--hair', recipe.hair);
    for (const accessory of recipe.accessories) args.push('--accessory', accessory);
    run(...args, '--out', sheet);
    await copyFile(join(temp, `${recipe.id}.avatar.png`), join(root, `public/art/${recipe.id}.png`));
    // The exporter creates a JSON sidecar. Keep it with the temporary full
    // sheet, not in public/. Portable layers/crops/geometry belong in
    // art/classes.json and art/recipe.json; the game consumes only the PNGs.
    const out = join(temp, `${recipe.id}-motion.png`);
    run('export', sheet, '--rect', '0', '32', '384', '64', '--out', out);
    await copyFile(out, join(root, `public/art/${recipe.id}-motion.png`));
    console.log(`Exported ${recipe.id}: portrait + eight directional clips`);
  }
} finally { await rm(temp, { recursive: true, force: true }); }
