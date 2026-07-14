## 1. Policy And Lifecycle

- [x] 1.1 Keep worktree execution disabled by default and preserve current non-worktree session behavior.
- [x] 1.2 Extend desktop capability advertisement with per-workspace worktree availability, setup profile summaries, cache policy summary, warm pool status, and apply/discard support.
- [x] 1.3 Persist session-level worktree metadata with opaque desktop-owned identifiers rather than mobile-provided paths.
- [x] 1.4 Allocate at most one managed worktree per isolated session and reuse it for all follow-up commands.
- [x] 1.5 Add recovery handling when a persisted session worktree is missing, invalid, already discarded, or no longer owned by the desktop agent.

## 2. Setup Profiles

- [x] 2.1 Add desktop-owned per-workspace setup profiles with fixed labels and commands from local configuration.
- [x] 2.2 Run setup before the first agent turn in a newly assigned worktree when the selected profile requires it.
- [x] 2.3 Compute setup readiness keys from lockfiles, toolchain markers, and project-configured extra files.
- [x] 2.4 Emit bounded setup lifecycle events: queued, running, succeeded, failed, skipped, and invalidated.
- [x] 2.5 Add retry setup and discard behavior for setup failures without exposing arbitrary shell commands to mobile.

## 3. Shared Caches

- [x] 3.1 Add desktop-configurable cache environment for managed worktree setup and agent processes.
- [x] 3.2 Support common cache families for Node, Python, Rust, Go, and build tooling where configured by the desktop owner.
- [x] 3.3 Prefer tool-supported shared caches over copying ignored dependency directories.
- [x] 3.4 Add diagnostics that show whether a worktree used shared cache policy without storing secret-heavy environment output.

## 4. Warm Worktree Pool

- [x] 4.1 Add optional per-workspace warm pool policy with default pool size zero.
- [x] 4.2 Prepare warm worktrees only under the desktop-managed worktree root and only for advertised workspaces.
- [x] 4.3 Run desktop-configured setup profiles during warm preparation and mark readiness by setup key.
- [x] 4.4 Assign a ready warm worktree to a new isolated session and remove it from the idle pool.
- [x] 4.5 Add TTL cleanup and stale-pool invalidation when base branch, base commit, setup key, or desktop policy changes.

## 5. Mobile Workbench

- [x] 5.1 Show worktree mode as an explicit opt-in when the desktop advertises it; do not present it as the default.
- [x] 5.2 Add task-type guidance that recommends active checkout for read-only tasks and isolated worktree for mutating tasks.
- [x] 5.3 Show worktree creation, setup, ready, running, failed, applied, discarded, and cleanup states in the session timeline.
- [x] 5.4 Ensure follow-up composer state makes reuse of the current session worktree clear.
- [x] 5.5 Add setup failure actions for retry setup, discard worktree, and policy-allowed fallback.
- [x] 5.6 Show changed files, diff stats, apply/merge entry point, discard, and continue actions after a worktree session completes.

## 6. Apply, Discard, And Cleanup

- [x] 6.1 Consume the conflict-safe, idempotent Apply result from `harden-worktree-isolation-and-apply` in the lifecycle and recovery UI.
- [x] 6.2 Keep apply/merge as an explicit user action separate from agent completion.
- [x] 6.3 Implement discard only for session-owned managed worktrees under the desktop-managed root.
- [x] 6.4 Preserve reviewable metadata after discard while removing local worktree files.
- [x] 6.5 Report cleanup failures without deleting files outside the managed worktree root.

## 7. Verification

- [x] 7.1 Add unit tests for worktree lifecycle, session reuse, invalid persisted worktrees, and default-off behavior.
- [x] 7.2 Add tests for setup key calculation, setup event emission, retry, and failure states.
- [x] 7.3 Add tests for cache policy environment construction without leaking full environment dumps.
- [x] 7.4 Add tests for warm pool assignment, invalidation, and cleanup.
- [x] 7.5 Add focused mobile tests for explicit opt-in, setup progress, follow-up reuse, apply, and discard states.
- [x] 7.6 Run `pnpm run check:js`.
- [x] 7.7 Run `pnpm test`.
- [x] 7.8 Do not run e2e tests unless explicitly requested.
