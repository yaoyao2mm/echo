# mobile-open-spec-progress Specification

## MODIFIED Requirements

### Requirement: Mobile users can review OpenSpec progress in a story timeline
The mobile UI SHALL present OpenSpec summary data as a mobile-friendly change list whose default rows prioritize title, status, and progress, with proposal context, affected specs, tasks, and actions available on demand.

#### Scenario: User opens Open Spec panel
- **WHEN** the user opens OpenSpec for an available workspace
- **THEN** the app opens the existing workspace panel with a concise change overview and refresh action
- **AND** orchestration controls appear only when the optional orchestration plugin is enabled and available

#### Scenario: User scans changes
- **WHEN** the summary includes one or more changes
- **THEN** each default row shows the change title or id, one status signal, and lightweight progress
- **AND** proposal context, affected specs, task checklist, and per-change actions require opening that change's details

#### Scenario: User opens a change detail
- **WHEN** the user selects a change while not in orchestration selection mode
- **THEN** the panel shows its existing read-only tasks and supporting OpenSpec context
- **AND** existing Apply, Sync, Validate, and Archive actions remain available without requiring orchestration
