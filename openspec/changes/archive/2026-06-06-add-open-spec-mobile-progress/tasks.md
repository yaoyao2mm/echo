## 1. Desktop Summary Reader

- [x] 1.1 Add a bounded OpenSpec workspace reader that detects `.OpenSpec`, `openspec`, `.openspec`, or `OpenSpec` at the workspace root.
- [x] 1.2 Parse `changes/<id>/tasks.md` checkboxes into grouped read-only task progress.
- [x] 1.3 Extract concise proposal/design/spec context without returning raw full file contents.
- [x] 1.4 Enforce workspace realpath safety, fixed OpenSpec paths, scan limits, and missing-file tolerance.

## 2. Relay And Desktop Request Flow

- [x] 2.1 Add a mobile API for requesting the current workspace OpenSpec summary with `projectId`.
- [x] 2.2 Route the request through the desktop agent using the same workspace allowlist constraints as file browsing.
- [x] 2.3 Return unavailable, stale, timeout, and parser-error states in a shape the PWA can render.

## 3. Mobile PWA UI

- [ ] 3.1 Add the top-right Open Spec icon button and hide it unless the selected workspace has OpenSpec data.
- [x] 3.2 Add an Open Spec mobile sheet with overview metrics, refresh/close controls, empty/error/loading states, and stale-cache indication.
- [x] 3.3 Render a Linear-style change story timeline with completion bars, proposal excerpts, affected specs, and expandable grouped tasks.
- [x] 3.4 Integrate panel closing, Escape/backdrop behavior, project switching, offline cache restoration, and composer availability updates.

## 4. Verification

- [ ] 4.1 Add parser tests for directory detection, task progress, summaries, limits, missing files, and symlink/path escape rejection.
- [x] 4.2 Add relay/desktop routing tests for target agent and workspace authorization.
- [x] 4.3 Add focused PWA tests for button visibility, project switching, cached offline rendering, and timeline rendering.
- [x] 4.4 Run `pnpm run check:js` and `pnpm test`; do not run e2e tests unless explicitly requested.
