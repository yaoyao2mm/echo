## 1. Desktop App Entrypoint

- [x] 1.1 Remove LaunchAgent detection, migration, and fallback controls from the Electron desktop app.
- [x] 1.2 Make desktop update/restart flows restart only the app-managed desktop agent.
- [x] 1.3 Remove user-facing package scripts for the legacy macOS LaunchAgent helper.

## 2. Settings And Diagnostics

- [x] 2.1 Remove LaunchAgent restart/status handling from desktop settings.
- [x] 2.2 Keep app-managed agent status and restart behavior working from settings.

## 3. Documentation

- [x] 3.1 Update README desktop setup sections to use only the Echo desktop app.
- [x] 3.2 Update deploy/friend docs that instruct users to run `desktop:mac` LaunchAgent commands.
- [x] 3.3 Remove stale LaunchAgent references from tests and tracker docs where they describe current behavior.

## 4. Verification

- [x] 4.1 Run focused JS/shell checks for touched desktop app, settings, scripts, and tests.
- [x] 4.2 Do not run e2e tests unless explicitly requested.
