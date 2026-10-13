# Studyloom

A private learning workspace at **studyloom.kaufmann.dev**. The home page greets you and shows open tasks, upcoming events, and pinned projects and Library items. Organize study materials into projects, and keep important files and information in the separate Library.

- Pause and resume recording; finalized transcript turns are saved with speaker labels and approximate timestamps. Audio is persisted in the browser before transmission and retained on the server until you delete the source.
- Upload any file type. Muse inspects it and chooses conversion tools or scripts. Unsupported or partly readable files retain their originals and show the extraction limitations.
- Paste a web address to add a page as a source. Studyloom downloads it, keeps the HTML as the original, and Muse extracts the article text like any other file. A link straight to a PDF or another file works too.
- Combine readable materials for source-cited chat, summaries, multiple-choice questions and written-answer quizzes. Answers, grading feedback and the model used are saved.
- Create audio summaries to listen to: Muse writes a cited narration, and ElevenLabs reads it aloud in the voice and speech model you pick from your account (models are listed with their relative credit cost; the first one is preselected). Play them in the browser or download the MP3. They use your ElevenLabs credits; an interrupted or failed one resumes without paying again for paragraphs already voiced.
- Choose models from Muse's live catalog. Text generation and file processing use your Muse Code subscription login. Audio transcription uses the separate Meta transcription API and incurs API charges.
- Save files, web links, contacts and notes at the Library root or in nested folders. Library files retain their originals for private viewing or download; they are not sent through Muse processing.
- Track tasks with a deadline (a date, optionally a time). Red means overdue or due today, amber means due within three days. Open tasks appear on the home page, the Tasks page, the calendar and their project; finished ones move to the Done tab. Reminders are visual only.
- Plan events in the calendar's month, week and agenda views. Events can last all day, span several days and repeat daily, weekly, every two weeks, monthly or yearly; a single occurrence can be skipped or changed without touching the series. Tasks and events can belong to a project.
- Subscribe to the calendar from a phone: Settings → Calendar feed creates a secret address (`/feed/<token>/studyloom.ics`) with your events and open tasks. Anyone holding the address can read the calendar; create a new address or turn the feed off there. Calendar apps refresh subscriptions on their own schedule.
- Export everything as an `.ics` file and import `.ics` files from other calendars (Calendar → ⋯). Importing shows a preview first, and importing the same file again updates instead of duplicating. Repeat rules without an equivalent (for example "first Monday of the month") import as single events; weekly rules on several weekdays become one series per weekday.

## Development

Requires Node **24.x**, pnpm **11.18.0**, and PostgreSQL. The existing local database container is `postgres-sveltekit`; use a separate `studyloom` database in it. Production PostgreSQL is separate infrastructure.

```bash
pnpm install
cp .env.example .env
# Configure DATABASE_URL and the authentication settings in .env.
pnpm db:migrate
pnpm dev
```

`pnpm dev` serves the interface and HTTP endpoints. Live recording and job processing run in the complete application server:

```bash
pnpm check
pnpm test
pnpm build
pnpm start
```

Native conversion tools are **deployment image dependencies**, not prerequisites for editing, checking, testing or building this repository in a terminal. Running actual processing jobs locally requires the same runtime tools as deployment. `pnpm tools:check` verifies them in the environment where processing runs.

Use `pnpm db:generate` after changing the Drizzle schema, then `pnpm db:migrate`. Migration files are committed under `drizzle/`. Never use schema push for deployment.

## Authentication Setup

Pocket ID admits users to one shared private workspace. Configure its access policy for your account only. The app uses Authorization Code with S256 PKCE and `client_secret_post`, then stores an opaque server-side session. Sessions expire after 24 hours idle or seven days total; passive polling and automatic recording traffic do not extend idle time. Signing out also signs out of the provider through RP-Initiated Logout.

- Public Client: **Off**
- Callback URL: `/auth/callback`
- Logout Callback URL: `/auth/logout/callback`
- Required authentication variables: `ORIGIN`, `OIDC_ISSUER`, `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET`; see the deployment environment below.

The public sign-in page links to the centralized Imprint and Privacy pages for `studyloom.kaufmann.dev`.

## Muse Connection

Open **Settings → Connect Muse** and complete the device login using your subscription account. Credentials persist under `DATA_DIR/muse-config/muse/`. The app never sets `META_API_KEY` for Muse, because API-key authentication bypasses subscription billing.

For local development, `MUSE_AUTH_IMPORT_PATH` can point to an existing Muse `auth.json`. It is imported once into the app's own profile; subsequent login, refresh and logout belong to that profile. Do not commit credentials or mount another application's entire configuration directory.

The integration uses Muse CLI's experimental MSP account/model methods and `muse exec --json`. It was checked against Muse 1.2.1; verify the login and job paths after CLI upgrades. Model choices come from `model/list`, and each generated result keeps its model ID. The default selection is `muse-spark-1.3-contributor`.

## Processing and Storage

`server.mjs` hosts SvelteKit, the authenticated recording WebSocket and two durable PostgreSQL job queues: one interactive job and one background job at a time. Run **one application replica**. Failed jobs can be retried; cancelled jobs retain saved source audio and files. Completed generated outputs use stable job IDs to avoid duplicates after a restart.

Muse runs as a trusted service for this single-user app and receives a job workspace and the stdio MCP tools in `build/runtime/muse-tools.js`. The app does not route file extensions through a fixed conversion pipeline. Commands run directly with the job workspace as the working directory and a restricted environment that never contains app secrets; output and time limits apply. The transcription MCP tool brokers authenticated requests without exposing the API key to conversion commands.

Project sources are stored under `DATA_DIR/materials`; Library files are stored under `DATA_DIR/library`. Temporary job workspaces are removed after processing. Transcripts and extracted chunks live in PostgreSQL, with a full-text index. Generated study tools keep source snapshots so later grading uses the original evidence and rubric. Back up PostgreSQL **and** the persistent data volume together.

Web pages are downloaded by the server, never by Muse. Only `http` and `https` addresses on the public internet are accepted: every address a request resolves to, including each redirect, must be public, so private, loopback, link-local and cloud-metadata addresses are refused and the connection uses exactly the addresses that were checked. A download follows at most 5 redirects, stops after 25 seconds and is limited to 50 MB (or `MAX_UPLOAD_BYTES`, if lower). The server sees only what a plain request receives: pages that need a sign-in, or that build their text in the browser with JavaScript, come back partly readable or unreadable and say so in the source's notes. Retrying a failed web source reads the stored copy and does not download the page again.

Uploads default to 2 GiB per source, using 8 MiB HTTP chunks. Audio is mono signed 16-bit PCM at 24 kHz. Live streams send audio at recording speed; interrupted audio uses the file transcription API before a new live stream starts. Browser support for tab/system audio varies; microphone capture is also available. Recording requires HTTPS outside localhost and browser permission to capture the chosen audio source.

## MCP Server

`https://studyloom.kaufmann.dev/mcp` (Streamable HTTP) lets AI apps use the workspace. Connect it with Claude (Settings → Connectors → Add custom connector), `claude mcp add -s user --transport http studyloom https://studyloom.kaufmann.dev/mcp` or `codex mcp add studyloom --url https://studyloom.kaufmann.dev/mcp` followed by `codex mcp login studyloom`.

Studyloom is its own OAuth 2.1 authorization server: discovery at `/.well-known/oauth-protected-resource/mcp` and `/.well-known/oauth-authorization-server`, dynamic client registration, S256 PKCE and a consent page after Pocket ID sign-in. Access tokens last one hour, refresh tokens rotate and last 30 days; Settings → Connected apps disconnects an app immediately. No extra environment variables are needed.

Tools: `list_projects`, `get_project`, `search_sources`, `read_source`, `get_output`, `get_conversation`, `create_project`, `add_text_source`, `save_overview`, `save_quiz` (citations are validated against the source text), `list_tasks`, `create_task`, `update_task`, `delete_task`, `list_events`, `create_event`, `update_event`, `update_occurrence`, `delete_event`, `browse_library`, `search_library`, `create_library_item`, `update_library_item`.

## Coolify Deployment

- Build Pack: **Nixpacks**
- Base Directory: `/`
- Domain: `https://studyloom.kaufmann.dev`
- Persistent storage mount: `/data`, writable by the application process.
- PostgreSQL: provision a dedicated production database and set `DATABASE_URL`.
- The server applies pending Drizzle migrations on startup before serving traffic, so a fresh database or a fast restart cannot crash on missing tables. The optional Post-Deployment Command `npx --yes pnpm@11.18.0 db:migrate` (executed via `sh -c`) remains as a fallback.
- Keep one replica. Enable WebSocket forwarding and allow at least 10 MiB request bodies in any additional proxy.

`nixpacks.toml` installs FFmpeg, LibreOffice, Poppler, Tesseract (English/German), Python/Pillow and fonts **inside the app image**, plus the Muse CLI. It invokes the pinned pnpm version because Nixpacks 1.41 otherwise selects outdated package-manager tooling. Node is selected from `package.json`.

Required environment variables:

- `DATABASE_URL`: production PostgreSQL connection string; runtime and deployment migration command.
- `ORIGIN`: `https://studyloom.kaufmann.dev`; build time (embedded as SvelteKit's `paths.origin` for CSRF checks) and runtime.
- `OIDC_ISSUER`: Pocket ID issuer URL; runtime.
- `OIDC_CLIENT_ID`: confidential client ID; runtime.
- `OIDC_CLIENT_SECRET`: confidential client secret; runtime secret.
- `TRANSCRIPTION_API_KEY`: Meta API key for Muse Voice Transcribe; runtime secret.
- `DATA_DIR`: set `/data` to use the persistent volume (code default: `.data`).

Optional environment variables:

- `ELEVENLABS_API_KEY`: ElevenLabs API key with text-to-speech and voice read access; enables audio summaries; runtime secret.
- `MAX_UPLOAD_BYTES`: maximum source size; default `2147483648`.
- `MUSE_BIN`: executable path; unset by default, auto-detects `/usr/local/bin/muse` then `PATH`. Set it only if the CLI was installed elsewhere.
- `MUSE_AUTH_IMPORT_PATH`: one-time import of an existing credential file; unset by default.
- `HOST`: bind address; default `0.0.0.0`.
- `PORT`: supplied by Coolify; standalone default `3000`.
- `BODY_SIZE_LIMIT`: Node adapter HTTP body limit; default `10M`.

Application secrets are not needed during the build. Complete the Pocket ID client settings and Muse device login after deploying. No privileged container or host container socket is used.

## Verification

`pnpm test` covers web page address checks and downloads, task urgency, repeating-event expansion, iCalendar feed/export/import, recorder resampling and recovery ordering, session expiry and redirect validation, credential environment isolation, workspace path confinement, WAV validation, citation checks, quiz scoring, the ElevenLabs client and MP3 joining; with `TEST_DATABASE_URL` set it also runs the database-backed suites, including resumable audio summaries. `pnpm check` checks Svelte and TypeScript; `pnpm build` creates both the SvelteKit application and the runtime and Muse tool bundles.

After deployment, verify Pocket ID login/logout, a calendar feed subscription from a phone, microphone and tab capture, pause/resume, interrupted recording recovery, one representative upload and one web page, a cited overview, an audio summary and quiz grading with your configured services, and connecting, using and disconnecting an MCP client. Unit tests do not replace those browser/device and deployed-service checks.
