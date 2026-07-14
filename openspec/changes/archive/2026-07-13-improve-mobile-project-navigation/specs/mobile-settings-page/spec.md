## ADDED Requirements

### Requirement: Mobile settings are available on a dedicated second-level page
The mobile app SHALL provide a dedicated settings page or route for preferences, account/status controls, and future management sections so the sidebar can focus on projects and conversations.

#### Scenario: User opens settings from the sidebar
- **WHEN** the mobile user taps the settings entry point in the sidebar
- **THEN** the app navigates to a dedicated settings page or route
- **AND** the user can return to the workbench without losing the selected project or active session state

#### Scenario: Existing sidebar preferences move to settings
- **WHEN** the settings page is available
- **THEN** appearance and personalization controls that previously lived in the sidebar are available from the settings page
- **AND** the sidebar no longer needs an expanded settings accordion for those controls

#### Scenario: Settings page hosts future management sections
- **WHEN** future Skills or plugin management surfaces are added
- **THEN** they can be added as settings-page sections
- **AND** the project sidebar remains focused on project switching, project actions, and conversation previews

### Requirement: Sidebar remains focused on project work
The mobile sidebar SHALL prioritize project selection, project-level actions, and recent conversation previews over global settings controls.

#### Scenario: User opens the project sidebar
- **WHEN** the mobile user opens the sidebar
- **THEN** the primary visible content is the project list, project actions, and recent conversations
- **AND** global settings controls are represented by a compact navigation entry rather than an inline configuration surface
