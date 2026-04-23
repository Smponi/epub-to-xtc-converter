# Project Architecture

## Overview

This repository has three main parts:

- `web/`: static browser app for previewing, converting and optimizing EPUB files entirely client-side.
- `cli/`: Node.js command line interface for batch conversion and EPUB optimization.
- `wasm-build/`: reproducible-ish Docker-based workflow for rebuilding the bundled CREngine WebAssembly artifacts.

## Runtime Flow

### Web app

1. `web/index.html` defines the UI shell and control IDs.
2. `web/app.js` initializes `crengine.js`, creates an `EpubRenderer`, and wires the UI to rendering/export logic.
3. `web/dither-worker.js` offloads dithering work from the main thread when available.
4. Export logic encodes rendered page buffers into `XTG` or `XTH` pages and wraps them into `XTC` or `XTCH` containers.

### CLI

1. `cli/index.js` parses commands and resolves configuration.
2. `cli/converter.js` loads the same bundled CREngine runtime used by the web app.
3. `cli/encoder.js` encodes page buffers into XTC-family formats.
4. `cli/optimizer.js` rewrites EPUB archives with JSZip and Sharp.

### WASM build pipeline

1. `wasm-build/Dockerfile` clones upstream CoolReader and the Emscripten SDK.
2. Multiple inline patches adapt the upstream build to the project’s WebAssembly use case.
3. `wasm-build/build.sh` produces `crengine.js` and `crengine.wasm`.
4. `make wasm-install` copies those artifacts into `web/`.

## Key Design Tradeoffs

- The web app is framework-free, which keeps deployment simple but concentrates a lot of behavior in a single `web/app.js`.
- The web app and CLI share the format concepts, but duplicate encoder/container logic instead of importing one shared module.
- The format documentation is reverse-engineered. In practice, the implementation is currently the strongest source of truth.

## Suggested Next Refactors

- Split `web/app.js` into modules such as state, rendering, export, optimizer and UI bindings.
- Extract shared format/container logic so the web app and CLI cannot drift.
- Vendor third-party browser dependencies locally to reduce CDN reliance.
- Add fixture-based regression tests for sample EPUBs and expected container headers.
