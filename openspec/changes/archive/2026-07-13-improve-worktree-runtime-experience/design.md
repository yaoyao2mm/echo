## Context

Git worktrees share repository object data, but each worktree has its own working directory. Runtime artifacts that are intentionally untracked or ignored are absent in a newly-created worktree. For Echo, that means isolation prevents pollution of the active checkout, but it also creates cold-start cost.

Echo's product boundary remains unchanged: the phone is a control surface, the relay authenticates and queues state, and the desktop agent is the only process allowed to touch local repositories or run local commands. Worktree optimization must preserve that boundary.

`harden-worktree-isolation-and-apply` is the safety prerequisite for this change. It owns fail-closed isolation requests, base-commit validation, conflict-safe Apply, and terminal-action idempotency. This design consumes those results and extends them with preparation, cache, warm-pool, and mobile lifecycle behavior.

## Goals / Non-Goals

**Goals:**

- Make optional worktree execution feel like a prepared project environment instead of a brand-new checkout.
- Reuse one managed worktree per session across initial prompt, follow-ups, cancellation, resume, and result review.
- Make dependency setup deterministic through desktop-owned project configuration.
- Reuse package-manager and build caches across worktrees when the underlying tooling supports it.
- Let the desktop owner opt into warm worktree preparation per workspace.
- Give mobile users clear state and recovery options when setup fails.
- Keep worktree mode off by default until this change is implemented and accepted.

**Non-Goals:**

- Making worktrees the default execution mode.
- Creating a remote shell or arbitrary command runner.
- Letting mobile users provide local paths, setup commands, cache paths, or cleanup paths.
- Copying dependency folders between worktrees as the default optimization.
- Solving every language ecosystem in v1; unsupported projects should still fail clearly and recoverably.

## Decisions

1. Session-level reuse is the baseline optimization.
   - A new isolated session MAY allocate a managed worktree when the backend advertises support and the user selects it on mobile.
   - Follow-up commands in that session MUST reuse the existing worktree while it is available.
   - A resumed session SHOULD reuse its prior worktree when the desktop agent can still validate it.
   - If the worktree is missing, invalid, or discarded, the system MUST require an explicit recovery path instead of silently creating a second divergent worktree.

2. Worktree mode remains explicit.
   - Default runtime behavior remains the existing non-worktree path.
   - The desktop agent MAY advertise worktree capability as unavailable or available; mobile owns the user's persistent Workspace preference.
   - Mobile may suggest isolated worktrees for mutating tasks and persist the choice. Desktop validates objective Git/worktree capability but does not act as a routine authorization gate.

3. Setup scripts are desktop-owned actions.
   - Setup commands live in desktop/project configuration, not in mobile requests.
   - Mobile can request "prepare this session worktree" only as a named capability already advertised by the desktop agent.
   - Setup output sent to the relay MUST be bounded and should avoid storing environment dumps or secret-heavy logs.
   - Setup failure MUST create a dedicated state with enough detail for the user to fix desktop configuration, retry setup, or discard the worktree.

4. Setup readiness is keyed by project state.
   - The desktop agent SHOULD compute a setup key from relevant lockfiles and toolchain markers, such as `pnpm-lock.yaml`, `package-lock.json`, `yarn.lock`, `bun.lockb`, `uv.lock`, `poetry.lock`, `requirements*.txt`, `Cargo.lock`, `go.sum`, `Gemfile.lock`, `.nvmrc`, `.node-version`, `.tool-versions`, and project-configured extra files.
   - A session worktree is ready when its setup key matches the current key and the last setup attempt succeeded.
   - When the key changes, the worktree MUST return to a needs-setup state before running an agent turn that depends on the setup profile.

5. Shared caches are environment policy, not copied folders.
   - Managed worktree processes SHOULD inherit or receive desktop-configured cache locations for common package managers and build systems.
   - Examples include npm cache, pnpm store, Yarn cache, uv cache, pip cache, Cargo registry/cache, Go module cache, compiler caches, and project build caches.
   - Echo should prefer content-addressed or tool-supported caches over copying ignored directories such as `node_modules` or `.venv`.
   - Advanced copy or clone strategies MAY be added later as desktop-only opt-ins, but they are out of scope for the default v1 behavior.

6. Warm pools are optional and desktop-controlled.
   - A workspace MAY advertise a `warmWorktreePool` policy with max count, branch/base rules, setup profile, and cleanup TTL.
   - The default max warm worktree count is zero.
   - Warm preparation MUST only run for desktop-allowed workspaces and desktop-configured setup scripts.
   - Assigning a warm worktree to a session transfers ownership to that session; it is no longer part of the idle pool.

7. Cleanup is explicit and recoverable.
   - Completed worktree sessions remain available for follow-up, review, apply, or discard until a retention policy removes them.
   - Discard removes the managed worktree only after validating it is under the desktop-managed worktree root and belongs to the session.
   - Apply/merge behavior should remain a separate explicit action from completion.
   - Cleanup failures should be visible but must not delete user checkout files outside the managed worktree root.
   - Apply remains an explicit mobile action; the baseline implementation already provides this entry point, while the prerequisite hardening change makes its result conflict-safe and idempotent.

## State Model

Add persisted session worktree metadata where compatible with existing storage:

- `mode`: `none`, `requested`, `active`, `applied`, `discarded`, `unavailable`
- `workspaceId`, `targetAgentId`, `baseBranch`, `baseCommit`
- `worktreeId`, managed relative path or opaque desktop id, and branch name
- `setupProfileId`, `setupKey`, `setupStatus`, `setupStartedAt`, `setupFinishedAt`
- `warmPoolSource`: whether this worktree was freshly created or assigned from a warm pool
- `cleanupStatus`, `retentionExpiresAt`

The relay should store opaque identifiers and display state. The desktop agent remains authoritative for real local paths.

## Desktop Policy

The desktop agent should advertise per-workspace worktree runtime policy:

- Worktree availability: disabled/optional.
- Managed worktree root status.
- Setup profile labels and whether setup is automatic or manual.
- Shared cache policy summary.
- Warm pool status and pool size.
- Apply/discard support.

The phone must not send custom paths or scripts back to the desktop. It can only select an advertised workspace, backend, model, permission preset, and optional worktree mode.

## Mobile UX

The mobile composer should keep worktree use understandable:

- Read-only or explanation tasks can stay on the active checkout.
- Mutating tasks may show an "isolated worktree" option when the desktop advertises support.
- Existing sessions show the active worktree state and reuse it for follow-ups.
- Setup progress appears before the agent turn starts.
- Setup failure offers retry setup, continue without worktree only if policy allows, or discard.
- Completed worktree sessions show changed files, diff stats, apply/merge entry point, discard, and continue.

The UI must avoid implying that worktrees are enabled by default before the user and desktop policy opt into them.

## Risks / Trade-offs

- Setup scripts can be slow or flaky -> show bounded logs, failure states, and retry controls.
- Shared caches can hide dependency drift -> key readiness from lockfiles/toolchain files and rerun setup when keys change.
- Warm pools consume disk and CPU -> default to zero, use TTL cleanup, and show desktop-side diagnostics.
- Some ecosystems require local mutable directories -> support clear project configuration before trying generic copying.
- Apply/merge can conflict with the active checkout -> keep it explicit and validate Git state before applying.
- Relay logs could capture sensitive output -> cap and filter setup logs; do not store environment dumps.

## Migration Plan

- Add schema fields with nullable/default values so existing sessions remain valid.
- Keep existing worktree-off behavior unchanged.
- Introduce desktop policy advertisement before exposing mobile controls.
- Implement session worktree reuse before setup scripts or warm pools.
- Add setup scripts and shared cache env behind desktop config.
- Add warm pool after setup readiness and cleanup are tested.
- Roll back by disabling the advertised worktree policy; existing non-worktree sessions continue to work.

## Verification

- Run `pnpm run check:js` after touching server, desktop agent, or browser JavaScript.
- Run `pnpm test` for the Node test suite.
- Do not run e2e tests unless explicitly requested.
