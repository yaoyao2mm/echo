## MODIFIED Requirements

### Requirement: Mobile users can review OpenSpec progress in a story timeline
The mobile UI SHALL present OpenSpec summary data as a mobile-friendly progress surface with overview metrics and a change timeline.

#### Scenario: User opens Open Spec panel
- **WHEN** the mobile user taps the Open Spec entry for an available workspace
- **THEN** the app opens a panel showing workspace context, OpenSpec directory name, aggregate task progress, change count, spec count, and a refresh action

#### Scenario: User starts an OpenSpec exploration
- **WHEN** the mobile user taps the Explore action in the Open Spec panel
- **THEN** the app pre-fills the Codex composer with an OpenSpec Explore prompt, keeps the message editable, and focuses the composer before the user sends it

#### Scenario: User reviews a change
- **WHEN** the summary includes one or more changes
- **THEN** each timeline row shows the change title or id, progress, task counts, concise proposal context when available, affected specs when known, and an expandable read-only task checklist
