# Library titles lose spaces while typing

- Fix timestamp: 2026-09-25 09:03:28 UTC (+0000)
- Base commit: 2d6db5108532463cb7725cc44c9b4a4bfd484635

## Symptom

Typing a space in a Library link title (or any Library item name, or the
file rename field) was impossible: the space disappeared as soon as it was
typed, so multi-word titles such as `My Link` could only be entered as
`MyLink`.

## Confirmed root cause

`libraryName` in `src/lib/domain.ts` used `z.string().trim()`, and that
schema is bound to the client-side Superforms validator (`zod4Client`) in
`LibraryEditor.svelte` and `LibraryFileRename.svelte`. Superforms parses the
typed value through the schema on each keystroke and writes the transformed
value back into the input, so the intermediate state `My ` was trimmed back
to `My` before the next word could be typed. Replayed keystroke-by-keystroke,
`libraryInput` rewrote `My ` to `My`, making the space unreachable. This is
the same mechanism as the earlier chat trailing-space fix; the Library schema
was missed there.

## Changes

- `src/lib/domain.ts`: `libraryName` no longer transforms with `.trim()`.
  It preserves typed whitespace and rejects blank names with a refine
  (`value.trim().length > 0`, message `Name is required.`), matching the
  existing `projectInput` pattern.
- `src/lib/server/api.ts`: Library names are trimmed once on the server when
  persisting, as projects already are — on create (`POST /api/library`) and
  on both rename paths (`PATCH`, file and non-file entries).
- `src/lib/server/security.test.ts`: extended the existing whitespace test to
  assert `libraryInput` and `libraryPatchInput` preserve `My Link ` /
  `hello ` and reject whitespace-only names with `Name is required.`

## Verification

- Keystroke-replay reproduction script: before the fix `My ` was rewritten to
  `My`; after the fix every intermediate value (including `My Link`) survives
  validation, for both the editor and rename schemas.
- `pnpm check` (0 errors)
- `pnpm test` (42 passed, 2 skipped — DB-gated)
- `pnpm build` (app plus runtime/MCP bundles)
- Prettier and ESLint clean on all touched files
