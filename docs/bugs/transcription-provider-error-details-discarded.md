# Transcription provider error details discarded

- Fix timestamp: 2026-09-15 16:35:32 UTC (+0000)
- Base commit: e991e81da270d31594289591538ec8b2b017d643

## Symptom

Live recording failed with `Transcription API rejected the stream.
Check the API key and usage limits.`, even when the key was valid and
partial transcripts had already arrived.

## Confirmed root cause

The realtime provider sends error events with `message` and
`errorType` fields (observed live: `invalid_request_error` /
`Ingress audio slower than real-time` when no audio is sent). The
`provider.on('message')` handler in `src/server/runtime.ts` discarded
those fields and always blamed the API key and usage limits, hiding
the real reason (e.g. stalled audio ingress from a backgrounded
mobile browser tab). A WebSocket handshake probe confirmed the key
and config are accepted (`sessionId` returned), so key/limits was the
wrong diagnosis for this class of failure.

## Changes

- Added exported `providerErrorMessage()` in `src/server/runtime.ts`
  that surfaces `errorType — message` (bounded to 300 chars) and keeps
  the key/limits guidance only when the provider gives no detail.
- The error branch now logs the raw provider event server-side
  (bounded to 1000 chars) and throws the detailed message to the
  client.
- Added two cases to `src/server/runtime.test.ts` covering the
  detailed message and the no-detail fallback.

## Verification

- `pnpm check` (0 errors)
- `pnpm test` (35 passed, was 32)
- `pnpm build` (app plus runtime/MCP bundles)
- Live WebSocket probe against the realtime endpoint confirmed the
  event shape the fix relies on
- Prettier and ESLint clean on all touched files
