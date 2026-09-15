# Interrupted model fallback plus paused-recording and worker gaps

- Fix timestamp: 2026-09-15 16:13:04 UTC (+0000)
- Base commit: 4bdf325d40d701a72ad90d15149752206dbf37ce

## Symptoms

- `pnpm check` failed with 7 errors: every model selector carried both
  `bind:value` and a separate `value`/`onchange` pair, and the Workspace page
  import failed as a consequence.
- A paused recording shown outside the browser that recorded it could neither
  be saved nor deleted, and it blocked project deletion.
- A failed file upload left the Upload button disabled with only an icon-only
  resume control and no way to discard the stuck upload.
- Worker claim errors after the first one were never logged.
- Retrying a grading job could regress an already complete attempt back to
  `grading`, causing a wasted re-grade.
- Study-tool generation was the only project mutation without a locked
  project row, so it could race project deletion.

## Confirmed root causes

The interrupted agent added a `selectedModel`/`processingModel` fallback to
the three model selectors but left the original `bind:value` in place next to
the new `value`/`onchange` attributes, which Svelte 5 rejects as duplicates.
It also left two over-indented blocks in `src/lib/server/api.ts`.

Paused recordings were deliberately protected from deletion, but the only
finalize path (`POST /api/recordings/:id/recover`) was reachable solely from
the same browser's Recorder recovery list, leaving other sessions with no
action. The Upload component kept failed state in `pending` with no discard
path. The worker's log-once flag was never reset after a successful claim.
The job-retry path reset attempts to `grading` unconditionally even though the
grade worker already returns early for complete attempts. The generate
endpoint inserted its job without the `FOR UPDATE` project lock used by every
sibling mutation.

A suspected tab-switch state-loss defect was disproven during verification:
bits-ui `Tabs.Content` keeps inactive panes mounted with the `hidden`
attribute, so drafts and selections already survive tab switches.

## Changes

- Chat, StudyTools, and Workspace model selectors now use one getter/setter
  binding (`bind:value={() => selectedModel, (value) => ...}`) that always
  displays and submits a model from the live catalog.
- Normalized the two over-indented blocks in `src/lib/server/api.ts`.
- Workspace shows a "Save recording" button for paused recordings that calls
  the recover endpoint with `finalize: true`.
- Upload gains a "Discard" button that clears a stuck pending upload.
- The worker log-once flag resets after every successful claim cycle.
- Job retry leaves `complete` attempts untouched instead of regressing them.
- Study-tool generation inserts its job inside a locked project transaction;
  the now-unused `enqueue` helper was removed from `src/lib/server/jobs.ts`.

## Verification

- `pnpm check` (0 errors, was 7)
- `pnpm test` (32 passed)
- `pnpm build` (app plus runtime/MCP bundles)
- Targeted ESLint and Prettier checks on all touched files
- Svelte autofixer clean on all four touched components
