# Production artifact failure keeps no model diagnostics

- Fix timestamp: 2026-09-15 16:42:43 UTC (+0000)
- Base commit: 29d093565faf0bf079e78b7beaad9ab35fc7ad60

## Symptom

Production uploads fail with `Muse completed without writing
extracted.json. Retry this job.` The model run itself reaches the
`completed` terminal state, so authentication and the model call work;
the job error contains no hint why the artifact is missing.

## Confirmed root cause

`runMuseWithArtifact` discarded everything Muse produced: the return
value of `museRun` (the final response text) was ignored, and the CLI
stderr tail held by `runProcess` was only surfaced on non-zero exits.
When Muse completes without writing the file, its final response
("the tool failed with…", "I have no way to write…") is usually the
only record of the cause, and it was thrown away. Local probing also
showed the echo provider never exercises MCP tools and the local
subscription login is stale, so the CLI↔MCP wiring cannot be
validated from this terminal; the production error must carry the
diagnosis itself.

## Changes

- `runProcess` accepts an optional `stderrTail` holder that receives
  the bounded stderr tail on every completion path.
- `museRun` returns `{ text, stderr }` instead of a bare string; both
  call sites are in `runMuseWithArtifact`.
- Added exported `missingArtifactError()` in `src/lib/server/jobs.ts`
  that appends the bounded model output and stderr tail (`Last
  output: …`) to the missing-artifact error.
- The artifact retry prompt now includes the previous final response
  so the second attempt can self-correct.
- Added `src/lib/server/jobs.test.ts` covering the diagnostic error
  shape, the second-attempt reporting, and the single-run success
  path.

## Verification

- `pnpm check` (0 errors)
- `pnpm test` (39 passed, was 35)
- `pnpm build` (app plus runtime/MCP bundles)
- Prettier and ESLint clean on all touched files

## Next production step

Deploy, retry one upload, and read the new job error: the sandbox
probe reports isolation failures directly, otherwise the attached
model output names the failing tool or step.
