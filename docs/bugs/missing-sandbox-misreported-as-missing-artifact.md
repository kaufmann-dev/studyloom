# Missing sandbox misreported as missing Muse artifact

- Fix timestamp: 2026-09-15 16:35:32 UTC (+0000)
- Base commit: e991e81da270d31594289591538ec8b2b017d643

## Symptom

Every PDF upload failed with `Muse completed without writing
extracted.json. Retry this job.`, even though Muse itself was
authenticated and reachable.

## Confirmed root cause

Muse runs with `--disable-shell --disable-write`, so its only way to
write `extracted.json` is the studyloom MCP `run_command` tool, which
executes through `sandboxCommand` (`prlimit` + `bwrap`). Reproduction
in the app runtime showed `prlimit: failed to execute bwrap: No such
file or directory` (exit 127), so every `run_command` call failed and
Muse could never produce the artifact. The worker then burned two full
model runs and reported the misleading missing-artifact error. This
contradicted the documented behavior that processing fails when
isolation cannot be established.

## Changes

- Added `ensureSandboxAvailable()` in `src/lib/server/sandbox.ts`: a
  cached functional probe that runs a trivial command through the same
  `prlimit` + `bwrap` + `sandboxArgs` path and throws an actionable
  error (pointing at `pnpm sandbox:check` and the deployment image)
  when isolation cannot be established. Failures are not cached, so a
  retry re-probes.
- Called the probe at the top of `runMuseWithArtifact` in
  `src/lib/server/jobs.ts`, the single choke point for ingest, chat,
  quiz, summary, and grading jobs, so no model run is spent when the
  sandbox is unavailable.
- Added `src/lib/server/sandbox.test.ts` covering the fail-fast error.

## Verification

- `pnpm check` (0 errors)
- `pnpm test` (35 passed, was 32)
- `pnpm build` (app plus runtime/MCP bundles)
- Live probe against the built bundle returns the actionable sandbox
  error in this runtime
- Prettier and ESLint clean on all touched files
