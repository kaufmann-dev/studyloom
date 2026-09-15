# Chat input loses trailing spaces and Muse jobs lose artifacts

- Fix timestamp: 2026-09-15 15:19:29 UTC (+0000)
- Base commit: 733ed7caf3515180709bc9d0478a20326feaa11b

## Symptoms

- Typing a space after the last visible character in chat immediately removed
  that space.
- Ingestion jobs could fail with an `ENOENT` error containing a private job
  workspace path when Muse finished without creating `extracted.json`.
- A complete upload could remain in `uploading` after the completion request
  failed, with no way to resume it in the same page session.
- Multiple Superforms on a project page reused the same generated form ID.

## Confirmed root causes

The shared client Zod schema used `.trim()` on fields that were bound to
Superforms. The client validator wrote the transformed value back during input
events, so a trailing space could not remain in the textarea. The server only
needs canonicalized project names and descriptions when persisting them.

Muse prompts required JSON artifacts but did not verify the artifact contract
after a successful process exit. The worker then called `realpath()` while
reading the missing file, exposing the internal workspace path through the job
error. The upload UI also discarded its chunk position when a request failed,
and all page forms accepted Superforms' identical default ID.

## Changes

- Preserve typed whitespace in client schemas while rejecting whitespace-only
  project names, chat messages, and quiz answers; trim only canonical project
  fields and conversation titles on the server.
- Require every selected source to have readable chunks before creating a
  generation or chat job.
- Add an artifact contract to every Muse task, retry once when the required
  file is missing, and report friendly errors for missing or malformed JSON.
- Redact filesystem paths from operational errors.
- Make file uploads resumable within the page, retry the failed chunk safely,
  and expose completion for fully uploaded sources.
- Give every Superform instance a stable unique ID and avoid stale passive
  chat polling state after a transient fetch failure.
- Resolve the built MCP entrypoint independently of the process working
  directory.
- Defer download URL revocation until the browser has started the download and
  clear output viewer errors before a retry.
- Generate Paraglide output explicitly for prepare, dev, and production builds;
  skip its Vite build hook because it crashes the installed Rolldown toolchain.

## Verification

- `pnpm check`
- `pnpm test -- --run` (31 tests)
- `pnpm build`
- Targeted ESLint and Prettier checks
- Live `agent-browser` check: `hello ` remains in the chat textarea and a
  complete upload shows `Continue processing`.
