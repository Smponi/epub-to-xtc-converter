# Security & Spec Review

## What was improved

- The production `Dockerfile` now uses an unprivileged Nginx base image instead of running the website as root.
- The Nginx config now emits baseline hardening headers, including CSP, `nosniff`, `DENY` framing and a restrictive permissions policy.
- The README now explicitly points to the architecture and review docs so future contributors can orient themselves faster.

## Security observations

### 1. Runtime container hardening is better, but supply-chain exposure remains

The container runtime issue was real and is now fixed. The browser app still depends on:

- `JSZip` from a public CDN at page load
- font files fetched from `raw.githubusercontent.com` at runtime

That means the app still has external runtime dependencies and reduced offline reliability. Best next step: vendor those assets locally and serve them from `web/`.

### 2. Browser-side EPUB parsing is intentionally permissive

The app processes arbitrary EPUB files supplied by the user. That is expected for this kind of tool, but it means:

- malformed EPUBs can still trigger heavy memory usage
- very large books can still stress the browser tab
- CREngine/WASM is part of the trusted computing base

There is no obvious DOM XSS path in the handwritten UI code because user-visible strings are generally written with `textContent`, not `innerHTML`.

### 3. The optimizer uses regex-based HTML/CSS rewriting

`cli/optimizer.js` performs broad text rewrites over CSS, HTML and OPF files. That is pragmatic, but it is not a full parser-based sanitizer. It can remove unsupported constructs effectively, yet edge cases may produce malformed markup or incomplete cleanup for unusual EPUBs.

## Spec conformance observations

### 1. The repository does not fully present the spec as authoritative

`docs/xtc-format-spec.md` already states that it is AI-generated and may contain issues. That disclaimer is important and should stay.

### 2. The implementation is closer to “reverse-engineered compatible” than “formally spec-complete”

Current encoder behavior in `cli/encoder.js` and `web/app.js` shows a few notable constraints:

- chapter `endPage` is written as the same page as `startPage`, so chapter ranges are placeholders rather than full spans
- some metadata fields defined in the spec are left zeroed or unused
- the implementation depends on reverse-engineered layout assumptions rather than upstream vendor validation

In other words: the format writer is likely useful and compatible for the target workflow, but it should not claim strict formal conformance without fixture validation against real device readers.

### 3. Documentation and code can drift

The web app and CLI each contain their own container-building logic. They are currently aligned, but this is a maintenance risk because either side can diverge from the documented format over time.

## Recommended next steps

1. Vendor `JSZip` and any default UI assets locally.
2. Replace runtime font downloads with bundled defaults or an opt-in fetch path.
3. Add fixture tests that validate generated header bytes, offsets and chapter/index tables.
4. Centralize encoder/container code in one shared module.
5. Consider parser-based EPUB rewrites if optimizer robustness becomes a priority.
