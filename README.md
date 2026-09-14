# Studyloom

A private learning workspace at **studyloom.kaufmann.dev**. Organize materials into projects, record microphone or browser-tab audio, and use selected sources for conversations, AI overviews and quizzes.

- Pause and resume recording; finalized transcript turns are saved with speaker labels and approximate timestamps. Audio is persisted in the browser before transmission and retained on the server until you delete the source.
- Upload any file type. Muse inspects it and chooses conversion tools or scripts. Unsupported or partly readable files retain their originals and show the extraction limitations.
- Combine readable materials for source-cited chat, summaries, multiple-choice questions and written-answer quizzes. Answers, grading feedback and the model used are saved.
- Choose models from Muse's live catalog. Text generation and file processing use your Muse Code subscription login. Audio transcription uses the separate Meta transcription API and incurs API charges.

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

Native conversion tools are **deployment image dependencies**, not prerequisites for editing, checking, testing or building this repository in a terminal. Running actual processing jobs locally requires the same runtime tools as deployment. `pnpm sandbox:check` verifies them and the operating-system isolation in the environment where processing runs.

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

Muse runs as a trusted service for this single-user app and receives a job workspace and MCP tools. The app does not route file extensions through a fixed conversion pipeline. Commands run through Bubblewrap in an offline Linux namespace with runtime directories mounted read-only and only that job's files writable. CPU, memory, output and time limits apply; processing fails if isolation cannot be established. The transcription MCP tool brokers authenticated requests without exposing the API key to conversion commands.

Sources are stored under `DATA_DIR/materials`; temporary job workspaces are removed after processing. Transcripts and extracted chunks live in PostgreSQL, with a full-text index. Generated study tools keep source snapshots so later grading uses the original evidence and rubric. Back up PostgreSQL **and** the persistent data volume together.

Uploads default to 2 GiB per source, using 8 MiB HTTP chunks. Audio is mono signed 16-bit PCM at 24 kHz. Live streams send audio at recording speed; interrupted audio uses the file transcription API before a new live stream starts. Browser support for tab/system audio varies; microphone capture is also available. Recording requires HTTPS outside localhost and browser permission to capture the chosen audio source.

## Coolify Deployment

- Build Pack: **Nixpacks**
- Base Directory: `/`
- Domain: `https://studyloom.kaufmann.dev`
- Persistent storage mount: `/data`, writable by the application process.
- PostgreSQL: provision a dedicated production database and set `DATABASE_URL`.
- Post-Deployment Command: `npx --yes pnpm@11.18.0 db:migrate` (executed via `sh -c`). For the first deployment, allow this command to finish before using the workspace.
- Keep one replica. Enable WebSocket forwarding and allow at least 10 MiB request bodies in any additional proxy.

`nixpacks.toml` installs Bubblewrap, FFmpeg, LibreOffice, Poppler, Tesseract (English/German), Python/Pillow and fonts **inside the app image**, plus the Muse CLI. It invokes the pinned pnpm version because Nixpacks 1.41 otherwise selects outdated package-manager tooling. Node is selected from `package.json`.

Required environment variables:

- `DATABASE_URL`: production PostgreSQL connection string; runtime and deployment migration command.
- `ORIGIN`: `https://studyloom.kaufmann.dev`; runtime.
- `OIDC_ISSUER`: Pocket ID issuer URL; runtime.
- `OIDC_CLIENT_ID`: confidential client ID; runtime.
- `OIDC_CLIENT_SECRET`: confidential client secret; runtime secret.
- `TRANSCRIPTION_API_KEY`: Meta API key for Muse Voice Transcribe; runtime secret.
- `DATA_DIR`: set `/data` to use the persistent volume (code default: `.data`).

Optional environment variables:

- `MAX_UPLOAD_BYTES`: maximum source size; default `2147483648`.
- `MUSE_BIN`: executable path; default `muse`.
- `MUSE_AUTH_IMPORT_PATH`: one-time import of an existing credential file; unset by default.
- `HOST`: bind address; default `0.0.0.0`.
- `PORT`: supplied by Coolify; standalone default `3000`.
- `BODY_SIZE_LIMIT`: Node adapter HTTP body limit; default `10M`.

Application secrets are not needed during the build. Complete the Pocket ID client settings and Muse device login after deploying. The processing image needs working unprivileged user namespaces; `pnpm sandbox:check` can diagnose that runtime. No privileged container or host container socket is used.

## Verification

`pnpm test` covers recorder resampling and recovery ordering, session expiry and redirect validation, credential environment isolation, workspace path confinement, WAV validation, citation checks and quiz scoring. `pnpm check` checks Svelte and TypeScript; `pnpm build` creates both the SvelteKit application and runtime/MCP bundles.

After deployment, verify Pocket ID login/logout, microphone and tab capture, pause/resume, interrupted recording recovery, one representative upload, a cited overview and quiz grading with your configured services. Unit tests do not replace those browser/device and deployed-service checks.
