# desktop-app-agent-entrypoint Specification

## Purpose
TBD - created by archiving change desktop-app-only-agent-entrypoint. Update Purpose after archive.
## Requirements
### Requirement: Echo desktop app is the only local agent entrypoint
Echo SHALL expose the desktop app as the only user-facing entrypoint for starting, stopping, restarting, updating, and configuring the local desktop agent.

#### Scenario: User starts Echo locally
- **WHEN** a user wants the local desktop agent to connect to the relay
- **THEN** the documented path uses the Echo desktop app
- **AND** no LaunchAgent or launchd helper command is presented as an alternative local agent entrypoint

#### Scenario: Desktop app update needs agent restart
- **WHEN** the desktop app applies an update or settings change that requires an agent restart
- **THEN** the desktop app restarts its app-managed desktop agent
- **AND** it does not attempt to detect or control a LaunchAgent fallback

#### Scenario: User checks local agent status
- **WHEN** a user opens local desktop settings or diagnostics
- **THEN** status reflects the app-managed desktop agent
- **AND** no LaunchAgent-specific status or migration action is shown
