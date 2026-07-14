# Improve Worktree Runtime Experience

Optimize Echo's optional worktree execution path so isolated sessions do not feel like a cold checkout every time. This change keeps worktree mode disabled by default until it is implemented, verified, and explicitly accepted for a later default-on decision.

Core themes:

- Reuse one worktree for the lifetime of a session and its follow-ups.
- Add desktop-owned setup scripts for dependency preparation.
- Share package-manager and build caches across managed worktrees.
- Optionally pre-warm worktrees from the desktop side.
- Let the mobile UI explain setup, reuse, apply, and discard states without exposing shell execution.

Desktop owners configure preparation through `ECHO_CODEX_WORKTREE_RUNTIME_JSON`. Warm pools remain disabled unless `maxCount` is greater than zero. Profile commands and cache paths stay local to the desktop agent.

```json
{
  "workspace-id": {
    "setupProfiles": [
      { "id": "install", "label": "Install dependencies", "command": "pnpm", "args": ["install", "--frozen-lockfile"] }
    ],
    "defaultSetupProfileId": "install",
    "cacheEnv": { "npm_config_cache": "~/.cache/npm" },
    "warmPool": { "maxCount": 1, "ttlHours": 24, "setupProfileId": "install" }
  }
}
```
