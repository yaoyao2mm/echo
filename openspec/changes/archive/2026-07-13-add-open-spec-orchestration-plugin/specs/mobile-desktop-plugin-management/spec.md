# mobile-desktop-plugin-management Specification

## MODIFIED Requirements

### Requirement: Desktop agent advertises manageable plugins
The system SHALL treat the desktop agent as the authority for available Echo plugins and SHALL expose bounded public metadata, enabled state, dependencies, and capabilities in its runtime snapshot.

#### Scenario: A desktop agent supports built-in orchestration
- **WHEN** the desktop agent publishes its runtime snapshot
- **THEN** the snapshot includes the built-in `orchestration` plugin as disabled by default
- **AND** the entry declares its `open-spec` dependency and bounded orchestration capabilities

### Requirement: Mobile only manages advertised plugin ids
The system SHALL allow mobile users to update only plugins advertised by the selected desktop agent, SHALL enforce advertised dependencies, and MUST NOT accept arbitrary plugin paths, commands, or source code.

#### Scenario: User enables orchestration with its dependencies available
- **WHEN** the selected desktop advertises enabled OpenSpec and managed Worktree capability
- **AND** the user enables the advertised orchestration plugin
- **THEN** relay queues only the bounded plugin update intent
- **AND** the desktop agent persists and advertises the enabled state

#### Scenario: User enables orchestration without a dependency
- **WHEN** OpenSpec is disabled or managed Worktree capability is unavailable
- **THEN** relay or desktop rejects the enable request with a bounded dependency reason
- **AND** orchestration remains disabled

## ADDED Requirements

### Requirement: Plugin state changes must preserve active managed work
The system SHALL stop admitting new plugin work when orchestration is disabled, but MUST NOT interpret the plugin switch as an unsafe force termination of active local work.

#### Scenario: User disables orchestration with no active Run
- **WHEN** no Run is active for the selected desktop
- **THEN** the plugin is disabled immediately
- **AND** mobile removes orchestration entry points and background status requests

#### Scenario: User disables orchestration during an active Attempt
- **WHEN** the selected desktop has active orchestration work
- **THEN** the system prevents new Runs and Attempts
- **AND** prompts the user to pause, cancel, or let the current Attempt reach a safe boundary
- **AND** it preserves managed Worktrees and artifacts
