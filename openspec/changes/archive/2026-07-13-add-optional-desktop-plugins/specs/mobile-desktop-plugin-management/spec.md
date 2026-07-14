# mobile-desktop-plugin-management Specification

## ADDED Requirements

### Requirement: Desktop agent advertises manageable plugins

The system SHALL treat the desktop agent as the authority for available Echo plugins and SHALL expose bounded public metadata and enabled state in its runtime snapshot.

#### Scenario: A desktop agent supports built-in plugins

- **WHEN** the desktop agent publishes its runtime snapshot
- **THEN** the snapshot includes plugin management capability and the built-in OpenSpec plugin entry

### Requirement: Mobile only manages advertised plugin ids

The system SHALL allow mobile users to update only plugins advertised by the selected desktop agent and MUST NOT accept arbitrary plugin paths, commands, or source code.

#### Scenario: User disables an advertised plugin

- **WHEN** the mobile user disables an advertised plugin
- **THEN** relay queues a bounded plugin update command and the desktop agent persists the enabled state locally

#### Scenario: User submits an unknown plugin id

- **WHEN** the mobile client submits a plugin id absent from the selected agent snapshot
- **THEN** relay rejects the request without queuing a desktop command

### Requirement: OpenSpec behavior follows plugin state

The system SHALL expose and execute OpenSpec support only while the `open-spec` desktop plugin is enabled.

#### Scenario: OpenSpec plugin is disabled

- **WHEN** the selected desktop agent advertises the OpenSpec plugin as disabled
- **THEN** mobile hides its OpenSpec workspace entry and relay rejects new OpenSpec summary requests

#### Scenario: A stale request reaches desktop after disable

- **WHEN** an OpenSpec summary request reaches the desktop agent after the plugin is disabled
- **THEN** the desktop agent refuses to read the workspace OpenSpec artifacts
