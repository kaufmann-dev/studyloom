# Connected Muse shows no models

- Fix timestamp: 2026-09-15 13:59:55 UTC (+0000)
- Base commit: 9b677a1eca33f39647a3826a176a5744a93baec5 (fix left uncommitted in worktree for review)

## Symptom

Settings shows `Status: Connected · <label>` but the Available-models section
says "Models appear after your Muse account is connected.", even after
refreshing. No error is displayed.

## Confirmed root cause

An expired or revoked Muse token. The `muse serve` host keeps reporting the
cached account (`account/read` returns `state: "accountLogin"` with the label),
but the provider catalog fetch fails, so `model/list` returns an empty
`models` array with `source: "bundledCatalog"`. The serve child logs:
"authentication failed: your saved login is no longer valid."

`museStatus()` passed that empty list straight through, so the UI concluded
"not connected yet" while the status line concluded "Connected". Reproduced
with an isolated config dir holding an invalidated copy of the token:
`accountLogin` + `models: []`, versus 4 models with the valid token.

## Changes

- `src/lib/server/muse.ts`
  - New `MuseStatus` type with optional `error` (matches the `MuseState`
    shape the Settings page already renders, including its `data.error` alert).
  - New `museStatusFromCatalog()` pure mapping: `accountLogin` plus an empty
    catalog yields `STALE_MUSE_LOGIN` ("Your Muse login is no longer valid.
    Disconnect, then connect your Muse account again.").
  - `museStatus()` returns that error instead of a silent empty list, and maps
    a failed `model/list` call to `MUSE_MODELS_UNREACHABLE` instead of failing
    the whole request.
  - `validateModel()` throws the reconnect message when the catalog is empty,
    so chat / study-tool creation points at the real problem.
- `src/lib/server/muse.test.ts`: unit tests for the populated, stale-login,
  and logged-out cases.

## Recovery for affected users

On the Settings page: Disconnect Muse, then Connect Muse account and approve
the new device code. The model list reloads on the next status refresh.
