# Bubblewrap sandbox removed; commands run directly

- Fix timestamp: 2026-09-15 16:52:21 UTC (+0000)
- Base commit: bdf61c522137e877d3f475f7686054284a77f98d

## Symptom

Production uploads always failed. The sandbox probe reported
`Processing needs the isolated Bubblewrap sandbox, but this runtime
cannot establish it`, confirming the Coolify container cannot provide
Bubblewrap isolation (no `bwrap` or no user namespaces). Every
processing job depended on that sandbox, so nothing could ever be
extracted.

## Confirmed root cause

The Bubblewrap requirement was an environment capability the
deployment runtime does not have. Layering probes, fallbacks, or
clearer errors on top cannot fix a missing capability, so the sandbox
was removed instead of worked around.

## Changes

- Deleted `src/lib/server/sandbox.ts` and its probe. New
  `src/lib/server/commands.ts` runs conversion commands directly via
  `/bin/bash` with the job workspace as cwd, a secrets-free
  environment (`PATH`, `LANG`, job-local `HOME` only), and the
  existing 180 s / 4 MiB limits. `prlimit` rlimits went away with the
  sandbox.
- `src/server/mcp.ts` uses `runCommand`; all tool descriptions and
  the ingestion contract use relative workspace paths instead of
  `/work` and no longer claim offline isolation.
- Removed the sandbox gate from `runMuseWithArtifact` in
  `src/lib/server/jobs.ts`.
- Replaced `scripts/check-sandbox.mjs` with `scripts/check-tools.mjs`
  (verifies conversion tools only) and renamed the npm script to
  `tools:check`.
- Removed `bubblewrap` and `util-linux` from `nixpacks.toml`.
- Replaced sandbox tests with `src/lib/server/commands.test.ts`
  (workspace cwd, no secret leakage, failure propagation) and dropped
  the obsolete `sandboxArgs` security test.
- Updated `README.md` and `AGENTS.md` to describe direct execution.

## Tradeoff

Commands now run as the app user without namespace, filesystem, or
network isolation. App secrets are still never passed to them, and
this is a single-user self-hosted app, but a malicious file could
in principle influence Muse-chosen commands beyond the workspace.

## Verification

- `pnpm check` (0 errors)
- `pnpm test` (40 passed)
- `pnpm build` (app plus runtime/MCP bundles)
- Prettier and ESLint clean on all touched files
