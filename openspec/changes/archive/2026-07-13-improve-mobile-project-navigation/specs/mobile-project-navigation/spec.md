## ADDED Requirements

### Requirement: Mobile users can hide projects from the sidebar without deleting local data
The mobile UI SHALL let a user remove a project from the sidebar/project list without deleting the local workspace directory, repository, worktree, sessions, or conversation history.

#### Scenario: User removes a visible project from the sidebar
- **WHEN** the mobile user confirms the remove-from-sidebar action for a visible project
- **THEN** the project no longer appears in the mobile sidebar for that user
- **AND** the desktop workspace directory is not deleted or modified
- **AND** existing sessions for that project remain stored

#### Scenario: User removes the active project
- **WHEN** the mobile user removes the currently selected project from the sidebar
- **THEN** the app selects another visible project when one exists
- **AND** the app enters the no-visible-project state when none exists
- **AND** no local filesystem deletion action is sent to the desktop agent

#### Scenario: Hidden project is advertised again by desktop
- **WHEN** the desktop agent continues to advertise a workspace that the user removed from the sidebar
- **THEN** the mobile sidebar keeps the project hidden according to the user's visibility preference
- **AND** the project can become visible again only through an explicit show/register action or equivalent user intent

### Requirement: Mobile users can register an existing local directory as a project through desktop-mediated browsing
The system SHALL provide a mobile flow for adding an existing local directory as an Echo project while keeping real filesystem authority on the desktop agent.

#### Scenario: User opens the existing-project flow
- **WHEN** the mobile user chooses to open an existing local project
- **THEN** the app shows only desktop-advertised import roots or browse roots for the selected desktop agent
- **AND** the mobile client does not ask the user to type an arbitrary absolute path

#### Scenario: User selects a directory to register
- **WHEN** the mobile user selects a directory from the desktop-mediated browser
- **THEN** the relay queues a registration request containing the target agent id, opaque root id, and bounded relative path
- **AND** the desktop agent validates the resolved directory before adding it as a workspace

#### Scenario: Selected directory is valid
- **WHEN** the desktop agent confirms the selected directory is inside an advertised import boundary and allowed as a workspace
- **THEN** Echo registers the directory as a project
- **AND** the mobile app adds it to the sidebar and switches to it

#### Scenario: Selected directory is invalid or unsafe
- **WHEN** the selected directory is outside the advertised import boundary, escapes through symlinks, duplicates an existing workspace, or fails desktop policy
- **THEN** the desktop agent rejects the registration
- **AND** the mobile app shows a bounded error state without registering the project

### Requirement: Mobile project conversation lists are capped by default
The mobile sidebar SHALL show a bounded preview of conversations per project by default and reveal the full list only after explicit user expansion.

#### Scenario: Project has five or fewer conversations
- **WHEN** the mobile sidebar renders a project with five or fewer conversations
- **THEN** all conversations for that project may be shown inline
- **AND** no show-more action is required

#### Scenario: Project has more than five conversations
- **WHEN** the mobile sidebar renders a project with more than five conversations
- **THEN** the app shows at most five conversations by default
- **AND** the app shows a discoverable action to reveal the remaining conversations

#### Scenario: User expands conversation list
- **WHEN** the user activates the show-more action for a project
- **THEN** the app renders the full conversation list for that project
- **AND** existing session filters, active-session highlighting, and follow-up actions continue to work

#### Scenario: User collapses expanded conversation list
- **WHEN** the user collapses an expanded project conversation list
- **THEN** the app returns that project to the bounded preview
- **AND** no sessions are archived, deleted, or hidden from search/history by the collapse action
