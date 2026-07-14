## Why

Echo currently still exposes legacy macOS LaunchAgent / launchd setup and control paths alongside the desktop app. That split creates two local agent entrypoints, stale-process confusion, and makes deployment follow-up ambiguous because some code changes require the desktop app agent to restart while the old helper can still report or manage LaunchAgent state.

Echo should have one local desktop entrypoint: the Echo desktop app. The app owns starting, stopping, restarting, updating, and opening settings for the desktop agent.

## What Changes

- Remove LaunchAgent / launchd management from the desktop app and local settings flow.
- Remove package scripts and helper behavior that present `scripts/macos-desktop-agent.sh` as a user-facing entrypoint.
- Update README and docs so users start and manage the local agent through the Echo desktop app only.
- Keep non-entrypoint implementation details that are still part of the product model, such as the desktop agent process itself and the desktop app-managed agent.

## Capabilities

### Modified Capabilities
- `desktop-app-agent-entrypoint`: Echo users start and manage the local desktop agent exclusively through the Echo desktop app.

## Impact

- Desktop app: remove LaunchAgent detection, migration menu items, and fallback restart logic.
- Desktop settings: restart/status/doctor copy and behavior should target the app-managed agent path.
- Scripts/package/docs: remove or de-emphasize launchd helper entrypoints and references.
- Tests: update assertions that still expect legacy LaunchAgent handling.
