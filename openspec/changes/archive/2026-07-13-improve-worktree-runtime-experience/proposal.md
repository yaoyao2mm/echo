## Why

Echo already has optional worktree execution, but a new Git worktree starts as a clean checkout. Ignored and untracked runtime state such as `node_modules`, `.venv`, generated build output, local databases, and dev-server caches are not copied. This makes isolated execution safer, but it also makes each new worktree feel expensive: the agent may spend time reinstalling dependencies or rediscovering project setup.

The product goal is still correct: worktrees should protect the user's active checkout when remote tasks mutate files. The experience needs a stronger runtime layer before worktree mode becomes a candidate for default-on behavior.

This change builds on `harden-worktree-isolation-and-apply`. Baseline validation, explicit failure instead of silent fallback, Apply conflict protection, and terminal-action idempotency belong to that prerequisite change; this change focuses on runtime preparation and the complete mobile lifecycle experience.

## What Changes

- Keep worktree mode disabled by default.
- Reuse the same managed worktree for every command and follow-up in a session.
- Persist and display worktree lifecycle state: creating, setting up, ready, running, completed, failed, applied, discarded, and cleanup pending.
- Add desktop-owned per-workspace setup scripts that run inside managed worktrees before the agent starts.
- Add shared dependency and build-cache configuration for managed worktree processes.
- Add optional desktop-controlled warm worktree preparation so common projects can start from a ready checkout.
- Add task-type guidance so read-only work can use the active checkout while mutating work can opt into an isolated worktree.
- Improve mobile review and recovery affordances around setup failures, changed files, apply, discard, and follow-up reuse.

## Capabilities

### Modified Capabilities

- `codex-worktree-execution`: Optional worktree sessions become reusable, setup-aware, cache-aware, and visible from mobile.
- `desktop-agent-runtime-policy`: Desktop-advertised policy controls whether worktrees, setup scripts, shared caches, and warm pools are available.
- `mobile-session-workbench`: Mobile users can see worktree readiness, setup progress, and post-run worktree actions without gaining arbitrary shell or path access.

## Non-Goals

- Do not make worktree execution default-on in this change.
- Do not let the phone send arbitrary shell commands, filesystem paths, setup scripts, or worktree paths.
- Do not expose Codex app-server, local shells, SSH hosts, or package-manager commands directly to the public relay or mobile client.
- Do not blindly copy ignored dependency directories such as `node_modules` or `.venv` between worktrees by default.
- Do not run e2e tests unless explicitly requested.
- Do not duplicate the low-level isolation and Apply safety work defined by `harden-worktree-isolation-and-apply`.

## Impact

- Desktop agent: worktree lifecycle, setup execution, warm pool, shared cache env, cleanup, and capability advertisement.
- Relay/store: persisted session worktree metadata, setup status, readiness events, and action states.
- Mobile PWA: task-type/worktree selection, lifecycle indicators, setup failure states, and apply/discard/follow-up affordances.
- Tests: focused unit and integration tests around worktree reuse, setup policy, cache configuration, warm pool behavior, and mobile UI state.
