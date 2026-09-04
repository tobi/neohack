# Third-party notices

## NetHack

`upstream/` contains NetHack source from
[NetHack/NetHack](https://github.com/NetHack/NetHack), based on commit
`04834a93165482a28257bac282543e3583658622`.

NetHack's copyright notices and license are retained in the source. See
[`upstream/dat/license`](upstream/dat/license). Local headless-port changes are
recorded in separate project commits after the vendored baseline.

The original local `upstream/.git` repository is preserved in the development
workspace. This repository vendors its source tree; it does not require that
nested Git directory to build. Optional upstream submodules retain their pinned
revisions and are declared in the root `.gitmodules`.

## Browser dependencies

Lit and Three.js are declared in `package.json` and pinned by `bun.lock`.
Their upstream licenses apply to those dependencies. Dependency installations
and generated bundles are not checked into this repository.

This notice does not assert an additional license grant for unrelated project
files.
