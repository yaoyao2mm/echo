## Why

The mobile Open Spec panel already helps users review active and archived changes, but starting a new OpenSpec exploration still requires manually remembering the right prompt shape. Users should be able to tap an Open Spec affordance, type the thing they want to explore, and send it through the normal Codex composer.

## What Changes

- Add an Explore action next to the Open Spec refresh control.
- Prefill the composer with an OpenSpec Explore prompt that asks Codex to create a focused change proposal and spec delta without implementing, applying, or archiving.
- Keep sending under the existing composer flow so the user can edit the prompt before sending.

## Capabilities

### Modified Capabilities
- `mobile-open-spec-progress`: Mobile users can start an OpenSpec exploration from the Open Spec progress panel.

## Impact

- Frontend: `public/index.html`, `public/app/open-spec.js`, and Open Spec styles.
- Tests: focused PWA tests for the Explore prefill behavior.
- E2E tests remain out of scope unless explicitly requested.
