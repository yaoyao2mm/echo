## Context

Echo is a mobile control surface for local Codex. The relay authenticates users and queues requests, while the desktop agent is the only process allowed to touch local repositories. The current file browser already proves the desired security pattern: mobile asks for a bounded operation against a selected workspace, the relay queues it for the owning desktop agent, and the desktop agent resolves paths inside its advertised workspace allowlist.

OpenSpec examples in nearby projects use `openspec/changes/<change-id>/proposal.md`, `design.md`, `tasks.md`, optional `.openspec.yaml`, and `openspec/specs/<capability>/spec.md`. The requested mobile UI should activate when the current workspace has an OpenSpec directory and should present progress like a project story timeline.

## Goals / Non-Goals

**Goals:**
- Detect OpenSpec directories named `.OpenSpec`, `openspec`, `.openspec`, or `OpenSpec`, preferring them in that order.
- Generate a bounded, read-only summary for the selected workspace from the desktop agent.
- Show a mobile-friendly progress panel with overview metrics, change timeline rows, expandable read-only task checklists, and refresh/error/offline states.
- Reuse Echo's existing mobile panel behavior, auth model, desktop-agent routing, and workspace allowlist guarantees.

**Non-Goals:**
- Editing `tasks.md`, creating specs, archiving changes, or invoking the OpenSpec CLI from mobile.
- Exposing arbitrary path reads, shell execution, or public access to Codex app-server.
- Building an e2e test suite for this pass.

## Decisions

1. Use a dedicated OpenSpec summary request instead of piggybacking on generic file browser calls.
   - Rationale: the mobile client needs one capability-level result, not a series of arbitrary reads. A dedicated request keeps path policy fixed on the desktop side and returns only parsed, bounded fields.
   - Alternative considered: call `/api/codex/files/list` and `/api/codex/files/read` from the PWA. That would work but would duplicate parsing client-side and expand the mobile file-read surface.

2. Keep all filesystem inspection in a new desktop-side parser module.
   - Rationale: the desktop agent already owns local filesystem access and workspace resolution. The parser can share the file browser path safety helpers or equivalent realpath checks.
   - Result shape: `{ ok, available, directoryName, projectId, workspace, overview, changes, specs, generatedAt }`.

3. Calculate completion only from `tasks.md` checkboxes.
   - Rationale: checkbox state is the only stable progress source in observed OpenSpec projects. Git status and inferred implementation state need separate product rules.
   - Parsing: match Markdown task items using `- [ ]`, `- [x]`, or `- [X]`; group them under the nearest preceding Markdown heading.

4. Cache summaries per workspace on the PWA.
   - Rationale: Echo already preserves useful mobile state while the desktop agent reconnects. The Open Spec panel should show the last summary as stale if commands are unavailable.

5. Treat Open Spec as read-only UI in v1.
   - Rationale: marking tasks complete from the phone would mutate repository files and needs explicit product policy, conflict handling, and review affordances.

## Risks / Trade-offs

- Large OpenSpec directories could be expensive to scan -> clamp number of changes/specs and per-file bytes, and show truncated counts in the summary.
- OpenSpec formats may vary across projects -> support the common `changes` and `specs` layout first, with graceful empty states when files are absent.
- Directory names are case/style variant -> detect the agreed compatible names, but do not search recursively beyond the workspace root.
- UI may crowd the topbar on narrow phones -> use an icon-only button, hide it when unavailable, and reuse the existing sheet/backdrop pattern.
- Parsed summaries might expose sensitive text if users put secrets in proposals -> read only known OpenSpec artifact files and cap returned excerpts; do not store raw full file contents in relay results.

## Migration Plan

- Add the new parser and request flow without changing existing file browser APIs.
- Add the PWA module behind directory detection so projects without OpenSpec see no new control.
- Run `pnpm run check:js` and `pnpm test`. Do not run e2e tests unless explicitly requested.
- Rollback is removal of the new route/request handler, parser, PWA module, styles, and tests; no database migration should be required unless the implementation chooses to persist a new queued request type in existing generic request storage.
