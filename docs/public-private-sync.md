# Public/Private Repository Sync

Echo has a public repository and a private downstream repository. The private repository is allowed to contain internal deployment policy, private backend integrations, and experiments. The public repository is the maintainable open-source core.

The synchronization rule is intentionally asymmetric:

- Public to private can be absorbed routinely.
- Private to public must be curated, split, and reviewed before it becomes a public PR.
- Codex app-server stays local to the desktop agent over stdio. Do not introduce a public route that exposes it.
- Phone-originated requests must remain inside desktop-advertised workspaces.

## Current Repository Shape

The initial public release was created as an unrelated history. Do not rely on a plain `git merge public/main` as the first step unless you are deliberately reconciling unrelated histories.

Use the audit script first:

```bash
pnpm run sync:audit -- --fetch
```

The report calls out:

- whether the refs have a common ancestor;
- public-only and private-only commit counts;
- changed files and top changed areas;
- public commits whose touched files are already present or have drifted in private;
- files that need manual review before any public PR;
- changed files containing secret-shaped or policy-shaped terms.

For maintainer checkouts, use separate remotes for the private downstream and public upstream:

```bash
origin  <private downstream URL>
public  <public upstream URL>
```

Keep the `public` push URL disabled in private checkouts unless you are intentionally preparing a public release branch:

```bash
git remote set-url --push public DISABLED
```

## Routine Public to Private Intake

1. Fetch both repositories.

   ```bash
   git fetch origin --prune
   git fetch public --prune
   pnpm run sync:audit
   ```

2. Check whether public contains a new commit not reflected in private.

   ```bash
   git log --oneline public/main --not origin/main
   git diff --name-status origin/main..public/main
   ```

3. Prefer small, topic-based intake branches.

   ```bash
   git switch -c reconcile/public-<topic> origin/main
   git cherry-pick -n <public-commit>
   git diff
   ```

4. Commit only after reviewing the touched files. Be extra cautious around:

   - `src/server.js`
   - `src/desktop-agent.js`
   - `src/lib/codexStore.js`
   - `src/lib/codexQueue.js`
   - `src/lib/codexInteractiveRunner.js`
   - `src/lib/codexWorktree.js`
   - SQLite migrations
   - `public/app/codex.js`
   - `public/app/sessions.js`
   - `.env.example`
   - deployment scripts and GitHub workflows

5. Run the default non-e2e checks.

   ```bash
   pnpm run check:js
   pnpm test
   ```

Do not run e2e tests unless someone explicitly asks for e2e coverage.

## Curated Private to Public Backports

Never merge the private branch directly into public. Start from `public/main` and extract a clean public patch.

```bash
git fetch public --prune
git switch -c upstream/<topic> public/main
git cherry-pick -n <private-commit>
```

Then inspect and split the patch:

```bash
git diff --stat
git diff
git restore --staged <private-only-file>
git restore <private-only-file>
git add -p
git commit -m "<public-safe subject>"
```

Good public candidates:

- general bug fixes;
- queue/session correctness fixes that do not expose private policy;
- mobile UI polish;
- tests that improve public confidence;
- documentation that does not mention private infrastructure;
- refactors that preserve the public product boundary.

Keep private:

- private backend/provider integrations;
- internal deployment scripts and URLs;
- hard-coded local paths;
- secrets, tokens, or credentials;
- private workflow policy;
- experimental features that are not ready to support publicly;
- APIs that let mobile execute arbitrary shell commands or arbitrary paths.

## Backport Review Checklist

Before opening a public PR from a private patch:

```bash
pnpm run sync:audit
git diff --check
rg -n "token|secret|password|passwd|api[_-]?key|bearer|private|internal|ssh|pem|p12|pfx|ECHO_" .
pnpm run check:js
pnpm test
```

Review every finding from the `rg` command. Some matches are expected in docs and env examples, but none should expose private values.

For mobile PWA behavior changes, prefer targeted non-e2e checks and report that e2e was not run unless it was explicitly requested.

## Commit Discipline

When developing in private, split reusable work from private policy:

```text
Add durable session event replay
Add private relay deployment policy
```

The first commit can be considered for public. The second commit stays private.

Avoid mixed commits like:

```text
Add session replay and internal deployment settings
```

Mixed commits are much harder to backport safely because they combine public core behavior with private operating assumptions.

## Cadence

Use this cadence until the repositories are closer together:

- Run `pnpm run sync:audit -- --fetch` before each release or public PR.
- Pull public changes into private promptly.
- Review the recent private commit queue weekly for public-safe candidates.
- Keep default private worktree execution off unless the desktop owner enables it.

## Backport Notes

When the private branch is much newer than the public tree, mobile UI backports often conflict across most touched mobile files:

- `public/app.js`
- `public/app/index.js`
- `public/index.html`
- `public/styles.css`
- `public/styles/composer.css`
- `public/styles/mobile.css`
- `public/sw.js`
- `test/mobile-viewport-metrics.test.js`

Treat mobile UI backports as small manual rebuilds against the public tree, not as mechanical cherry-picks, until public catches up to the private mobile refactor history.

Good first public candidates should be:

- one-file or two-file fixes;
- independent tests or docs;
- bug fixes that do not depend on the private mobile component split;
- changes that avoid relay auth, session ownership, runtime policy, deployment, and backend-provider surfaces.
