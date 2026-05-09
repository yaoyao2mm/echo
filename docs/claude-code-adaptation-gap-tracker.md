# Claude Code Adaptation Gap Tracker

Last reviewed: 2026-05-08

This tracker records the Claude Code adaptation gaps that were found after Echo became a multi-backend remote agent surface. The original problem was not that every Codex app-server capability had to exist in Claude Code immediately. The problem was that mobile, desktop, documentation, and recovery flows still treated Codex-specific behavior as if it were backend-neutral.

## Current State

Status: closed for the current adaptation pass.

Echo now treats desktop-advertised backend capabilities as the source of truth. Unsupported Claude Code capabilities are blocked or hidden before the user queues work, instead of failing later in the desktop runner.

The built-in Claude Code backend still intentionally declares these default limitations:

- `attachments: false`
- `compaction: false`
- `approvalRequests: false`
- `interactionRequests: false`

Those are no longer UX bugs. They are capability boundaries surfaced through runtime metadata, relay validation, mobile controls, and README documentation.

These compatibility names intentionally remain:

- `/api/codex/*` route names
- `codex_*` SQLite table names
- `ECHO_CODEX_*` workspace/worktree compatibility variables
- `src/lib/codex*.js` modules that still own shared session, queue, Git, file, and worktree plumbing
- `dist/Echo Codex.app` bundle path and executable name for existing macOS scripts

Visible product copy has been moved toward "Echo", "agent", "backend", or selected-backend labels. The macOS bundle path remains a compatibility exception; the generated bundle display name and the Electron shell now use `Echo`.

## Closed Items

| Item | Status | Result |
| --- | --- | --- |
| 1. Context compaction control was not capability-gated | Done | Mobile manual and automatic compaction now require backend `compaction` support. Unsupported backends show "当前后端暂不支持远程上下文压缩" and relay rejects the command before queueing. |
| 2. Screenshot attachment UI used mixed capability fields | Done | Mobile normalizes attachment support through runtime capabilities, blocks unsupported image selection/paste/send, and relay rejects unsupported attachments before desktop execution. |
| 3. Visible mobile copy was hardcoded to Codex | Done | High-visibility mobile status, composer, stop, quick-skill rewrite, and conversation labels now use generic or selected-backend wording. Internal function/storage names remain unchanged. |
| 4. Approval and interaction fallback copy was Codex-specific | Done | Approval and interaction UI now uses selected backend labels or generic agent copy. Unsupported backend flows are capability-gated. |
| 5. Context usage was Codex app-server specific | Done | Echo now accepts both Codex `thread/tokenUsage/updated` and Echo-native `context.usage.updated` / `context/usage/updated` events. Claude stream `usage` payloads are mapped into the shared shape. |
| 6. Remote compaction was treated as a generic session feature | Done | README and mobile now describe compaction as backend-specific. Codex keeps remote compaction; Claude remains disabled with clear copy. |
| 7. Fork-summary and session memory still said Codex | Done | Memory and fork-summary prompts now use backend-neutral "agent result" and "new backend session" wording. Regression coverage checks that Claude-bound fork summaries do not include hardcoded Codex wording. |
| 8. Claude resume recovery used only recent visible history | Done | Claude first uses native `--resume` when a thread id exists. If native resume fails, or if Echo has no native Claude thread id, the runner starts a fresh Claude session with Echo session memory first and recent visible history as supplemental context. It emits `thread.recovered` with `recovery.strategy = "echo-memory-rebuild"` so mobile can explain how context was restored. |
| 9. Claude permission modes were mapped through Codex-like presets | Done | Permission selection is backend-aware. Claude `strict` is presented as plan-only, while `approve` maps to edit-accepting mode and `full` maps to bypass mode only when desktop policy advertises it. |
| 10. Desktop settings could not configure or diagnose Claude | Done | Desktop settings now expose built-in Claude fields, `ECHO_AGENT_BACKENDS_JSON`, backend status, backend roster, and command health for enabled backends. |
| 11. macOS LaunchAgent env whitelist omitted Claude keys | Done | LaunchAgent parsing, plist generation, and `print-env` now include built-in Claude keys and `ECHO_AGENT_BACKENDS_JSON`, with regression coverage. |
| 12. App-managed desktop agent env loading needed verification | Done | The Electron shell resolves the repo root from `Resources/echo-root` in packaged mode, spawns with `cwd: rootDir`, and now explicitly merges the repo `.env` before spawning `src/desktop-agent.js`. Process env still overrides `.env`, matching dotenv behavior. |
| 13. README overstated backend-neutral capabilities | Done | README now includes Chinese and English capability matrices for Codex app-server, built-in Claude Code, and Claude Code compatible profiles. |
| 14. Server errors and desktop logs were Codex-specific | Done | Relay errors and desktop logs use generic agent/backend language. Electron shell, PWA manifest, generated bundle display name, network doctor, desktop update, and client-facing app-server rejection text now use `Echo`. Compatibility paths remain documented. |

## Implementation Notes

### Capability Gating

Mobile runtime helpers now resolve support from `runtime.capabilities.supports.*`, with legacy boolean fallback only for compatibility. Codex runtimes retain Codex-specific default support so old sessions are not misclassified.

Claude default support remains:

```json
{
  "text": true,
  "attachments": false,
  "cancellation": true,
  "contextUsage": true,
  "compaction": false,
  "approvalRequests": false,
  "interactionRequests": false,
  "gitSummary": true,
  "worktree": true
}
```

### Context Usage

Echo now stores and displays a backend-neutral context usage shape:

- Codex app-server events: `thread/tokenUsage/updated`
- Echo-native events: `context.usage.updated`
- Alternate wire form: `context/usage/updated`

Claude Code stream-json `usage` fields are normalized into the same structure and surfaced in the mobile context indicator.

### Claude Recovery Strategy

The selected strategy is:

1. Resume native Claude session state with `--resume <appThreadId>` when Echo has an app thread id.
2. If native resume fails, create a new Claude session id and send a recovery prompt.
3. Prefer Echo session memory summary for recovery.
4. Include recent visible user/assistant messages only as supplemental context.
5. Emit `thread.recovered` so mobile shows a system timeline note such as "已用 Echo 会话摘要重建上下文".

This is an explicit Echo-owned recovery path, not an unlabelled best-effort retry.

### Desktop Environment

LaunchAgent mode and app-managed mode now both preserve Claude configuration:

- LaunchAgent mode whitelists the built-in Claude keys and `ECHO_AGENT_BACKENDS_JSON`.
- App-managed mode reads the repo `.env`, overlays `process.env`, sets desktop defaults, and spawns the agent with `cwd: rootDir`.
- Packaged app root resolution is anchored by `Resources/echo-root`, which is generated by `scripts/macos-create-app.sh`.

### Naming Boundaries

Keep compatibility-sensitive names unless a separate migration is planned:

- Database tables and existing API paths still use `codex`.
- Workspaces still use `ECHO_CODEX_WORKSPACES`.
- Worktree settings still use `ECHO_CODEX_WORKTREE_*`.
- The physical macOS bundle path remains `dist/Echo Codex.app`.

Use backend-neutral or selected-backend wording for user-facing UI, logs, docs, and model prompts.

## Validation

Passed targeted non-e2e tests:

```bash
node --test test/backend-adapter-contract.test.js test/claude-code-interactive-runner.test.js test/codex-queue.test.js test/mobile-composer-routing.test.js test/mobile-runtime-controls.test.js test/session-timeline.test.js test/macos-desktop-agent-env.test.js
```

Result: 66/66 passed.

Passed syntax and script checks:

```bash
pnpm run check:js
pnpm run check:shell
```

Full `pnpm test` was not run because the project rules say not to run e2e tests unless explicitly requested, and the default test glob includes `mobile-codex-e2e.test.js`.

## Future Product Work

These are not open adaptation blockers. They are future feature decisions:

- Add real Claude screenshot/file attachment support after validating a safe `--file` or equivalent flow.
- Map future Claude permission or interaction events into Echo approval/interaction primitives if Claude exposes a stable event shape.
- Consider using Claude `--fork-session` for a future native fork mode. The current Echo fork-summary path is intentionally backend-neutral and memory-driven.
- Rename the physical macOS bundle path from `Echo Codex.app` only with a migration plan for existing scripts and user installs.
