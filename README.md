# Studyloom

A private learning workspace at **studyloom.kaufmann.dev**. The home page greets you and shows open tasks, upcoming events, and pinned projects and Library items. Organize study materials into projects, and keep important files and information in the separate Library.

- Pause and resume recording; finalized transcript turns are saved with approximate timestamps (audio recovered after an interruption is transcribed afterwards, with speaker labels). Audio is persisted in the browser before transmission and retained on the server until you delete the source.
- Upload any file type. Studyloom recognises files by their content and extracts the common formats itself: text files are stored as they are, audio and video are transcribed with speaker labels, and PDFs and paginated Office/OpenDocument files are read page by page (scanned pages with OCR). Spreadsheets retain cell addresses, formulas, number formats, merged ranges and named ranges alongside visual review of bounded sheet regions, including charts. PDFs and documents converted to PDF receive visual review of every page in sequential batches of at most eight units; this uses more Claude capacity and takes longer than text-only extraction. Existing materials require reprocessing to benefit. Claude then cleans document text up — logos, running headers and footers, page numbers — and writes it as Markdown: tables stay tables, formulas become LaTeX, diagrams with a clear structure are redrawn as Mermaid, and figures that carry content are cut out, stored with the source and shown where they belong. Exercises and their answer keys are recognised and kept apart from the teaching text, including solutions that are only marked by colour or a cross. Sources extracted before this need "Reprocess" to gain it. Images and unusual formats go to Claude, which chooses its own conversion tools. Failed document or workbook preparation fails the job so missing visual content cannot silently pass. Unsupported or partly readable files retain their originals and show the extraction limitations.
- Decide when sources are processed: with "Process immediately" switched off, uploads and web pages are only stored ("Not processed") and use no Claude capacity until you start them from the sources table, one by one or several at once. Any extracted source can be reprocessed; it stays usable until the new extraction is saved.
- If Claude reaches its usage limit while reading pages, slides or spreadsheet regions, Studyloom pauses and shows how many units are saved. Choose **Resume processing** when you want to use Claude again. Each completed block keeps its text and figures across restarts. Processing continues at the first unfinished block.
- Each project has pages for its sources, study tools, chat and schedule. The sources table shows type, size, status and what was extracted (sections, figures, exercises); a source opens with its original beside the extracted content.
- Paste text straight into a project as a source: it is stored unchanged, split into citable parts at paragraph breaks and ready right away, without Claude processing. It is named after its first line unless you name it.
- Paste a web address to add a page as a source. Studyloom downloads it, keeps the HTML as the original, and Claude extracts the article text. A link straight to a PDF or another file is read like an upload.
- Combine readable materials for source-cited chat, summaries and quizzes. Answers, grading feedback and the model used are saved. Answers and overviews can contain tables, formulas and diagrams.
- Choose a coverage instead of a length: Light (the core ideas), Standard (every major topic) or Comprehensive (every concept, formula and exercise of the sources). The size of a quiz, lesson, audio summary or study session then follows from how much the sources contain.
- Quiz questions can hold several answer fields in one question, as in Moodle's embedded answers: dropdowns in a sentence or a table (matching, classification, yes/no matrices, several true/false statements), cells to mark, short text, numbers (German and English formats are read) and free text. Everything except free text is graded at once on the server; free text is graded by Claude. At Comprehensive coverage every exercise found in the sources is asked, with the answer from the sources' own solutions where they exist. Large quizzes are split into parts; unsubmitted answers are kept in the browser.
- Learn with lessons: each chapter is explained step by step on slides (figures from your sources, tables, formulas, diagrams, or generated illustrations) and then checked with questions you answer by typing and clicking. After each answer you see what was right and hear or read why. Move through a lesson in order with Continue or jump between chapters and sections; your place and answers are kept. The voice is optional: off, voiced on demand when you first play an explanation, or everything in advance; you can add, change or remove it later. Feedback on clicked and typed answers is prepared when the lesson is created, so studying needs Claude only for free-text answers.
- Create audio summaries to listen to, either read by one narrator or as a conversation between a tutor and a learner who asks the questions you would ask and voices typical misconceptions. Scripts are built for learning, including with ADHD: a hook, a map of the parts, signposts ("Part two of three"), a concrete example before each general idea, a "Pause and think" question in every part followed by real silence before the answer, mini recaps and a final recap. Claude writes the cited script, and ElevenLabs reads it aloud in the voices and speech model you pick from your account (models are listed with their relative credit cost; the first one is preselected). Play them in the browser or download the MP3. They use your ElevenLabs credits; an interrupted or failed one resumes without paying again for turns already voiced.
- Study out loud: a voice tutor explains one part at a time, asks you a question and listens to your spoken answer for as long as you need; pauses never end it. Press I'm done (or Space) when you have finished. The tutor then says what was right, completes or corrects your answer, asks at most one follow-up and moves on. Space also skips what is being said. Listening pauses after ten minutes without I'm done. Claude plans the session and ElevenLabs voices it in advance; only the feedback is written and voiced live. Each run is saved with your answers, the tutor's verdicts and a "Review these" list, and an interrupted run resumes where it stopped. Answers are transcribed while you speak; their audio is not kept. Sessions use ElevenLabs credits for the plan, the feedback and transcribing your answers, and your Claude subscription. Headphones keep the tutor's voice out of your microphone.
- Choose models from Claude Code's live list. Its aliases such as Opus, Sonnet and Haiku follow the versions available through the installed SDK runtime and your account, and Default is Claude Code's recommendation for your plan. Text generation and document processing use your Claude subscription. Transcription and speech use ElevenLabs and its credits.
- Give each project its lecturers, picked from Library contacts marked as lecturers; the projects list shows each project's description and lecturers and can be sorted by recent updates, name or lecturer.
- Save files, web links, contacts and notes at the Library root or in nested folders. Library files retain their originals for private viewing or download; they are not sent through Claude processing.
- Track tasks with a deadline (a date, optionally a time). Red means overdue or due today, amber means due within three days. Open tasks appear on the home page, the Tasks page, the calendar and their project; finished ones move to the Done tab. Reminders are visual only.
- Plan events in the calendar's month, week and agenda views. Events can last all day, span several days and repeat daily, weekly, every two weeks, monthly or yearly; a single occurrence can be skipped or changed without touching the series. Tasks and events can belong to a project.
- Show your Moodle calendar: Settings → Moodle calendar takes the calendar export address from Moodle (Calendar → Import or export calendars → Export calendar → Get calendar URL). Studyloom downloads it on connecting, every 30 minutes and on Sync now. Moodle sessions become events, and entries without a duration (due dates, quiz openings and closings) become tasks. A Moodle feedback activity with matching “beginnt” and “endet” entries in the same course appears as one task with an opening time and a deadline. Only the deadline can become overdue. An unmatched opening remains a separate opening date. Moodle items are marked with a cap icon and are read-only; Moodle tasks can still be ticked off, and that stays after later syncs. Moodle items removed in Moodle disappear unless they are already past. Disconnecting removes every Moodle item. The address works like a password: it is stored on the server and never shown again.
- Subscribe to the calendar from a phone: Settings → Calendar feed creates a secret address (`/feed/<token>/studyloom.ics`) with your events and open tasks, Moodle ones included. Subscribe to this feed instead of Moodle's own address, or every Moodle item shows twice. Anyone holding the address can read the calendar; create a new address or turn the feed off there. Calendar apps refresh subscriptions on their own schedule.
- Export your own events and tasks as an `.ics` file and import `.ics` files from other calendars as your own (Calendar → ⋯). Moodle items are left out of the export, and an import skips entries the Moodle sync already holds. Importing shows a preview first, and importing the same file again updates instead of duplicating. Repeat rules without an equivalent (for example "first Monday of the month") import as single events; weekly rules on several weekdays become one series per weekday.

## Development

Requires Node **26.x**, pnpm **12.16.1**, and PostgreSQL. The existing local database container is `postgres-sveltekit`; use a separate `studyloom` database in it. Production PostgreSQL is separate infrastructure.

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

Native conversion tools are **deployment image dependencies**, not prerequisites for editing, checking, testing or building this repository in a terminal. Running actual processing jobs locally requires the same runtime tools as deployment. `pnpm tools:check` verifies them in the environment where processing runs, including `/usr/bin/python3` with the `python3-uno` bridge. Keep `scripts/prepare-spreadsheet.py` in the application image; it is invoked from the application working directory.

Use `pnpm db:generate` after changing the Drizzle schema, then `pnpm db:migrate`. Migration files are committed under `drizzle/`. Never use schema push for deployment.

## Authentication Setup

Pocket ID admits users to one shared private workspace. Configure its access policy for your account only. The app uses Authorization Code with S256 PKCE and `client_secret_post`, then stores an opaque server-side session. Sessions expire after 24 hours idle or seven days total; passive polling and automatic recording traffic do not extend idle time. Signing out also signs out of the provider through RP-Initiated Logout.

- Public Client: **Off**
- Callback URL: `/auth/callback`
- Logout Callback URL: `/auth/logout/callback`
- Required authentication variables: `ORIGIN`, `OIDC_ISSUER`, `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET`; see the deployment environment below.

The public sign-in page links to the centralized Imprint and Privacy pages for `studyloom.kaufmann.dev`.

## Claude Connection

Studyloom runs Claude through the Claude Agent SDK, which ships its own Claude Code binary; nothing else is installed. It authenticates with a long-lived subscription token: run `claude setup-token` on any computer with a Claude Pro, Max or Ultra plan, approve it in the browser and set the printed token as `CLAUDE_CODE_OAUTH_TOKEN`. The token lasts a year; create a new one before then. **Settings** shows whether it is set and which models are offered.

The model list comes from Claude Code itself (`default`, `opus`, `sonnet`, `haiku`, …). These aliases resolve to the newest model of each kind, so new Claude releases arrive by updating `@anthropic-ai/claude-agent-sdk`, without code changes. Each generated result keeps the alias it used. ElevenLabs transcription models (`scribe_v2`, `scribe_v2_realtime`) are constants in `src/lib/server/elevenlabs.ts`, because ElevenLabs lists no transcription models.

## Processing and Storage

`server.mjs` hosts SvelteKit, the authenticated recording and study session WebSockets and three durable PostgreSQL job queues: one interactive job, one background job and one lesson-voicing job at a time. Run **one application replica**. Failed jobs can be retried; cancelled jobs retain saved source audio and files. Completed generated outputs use stable job IDs to avoid duplicates after a restart.

Uploads are sniffed by content, never by file extension (`src/lib/server/extract.ts`). The server runs pdfinfo, pdftotext, pdftoppm and Tesseract, LibreOffice and FFmpeg itself, and transcribes media with ElevenLabs. Claude Code runs with all of its built-in tools switched off and no settings loaded; it gets the job workspace and Studyloom's own tools (run a command, read a file, view an image, cut a figure out of an image, transcribe audio), which run inside the app. Commands run directly with the job workspace as the working directory and a restricted environment that never contains app secrets; output and time limits apply. Generated results come back as structured output checked against a schema; source extractions are written to the workspace. The transcription tool calls ElevenLabs inside the app, so the API key never reaches commands.

Spreadsheet preparation uses a private LibreOffice UNO process with macros and external-link updates disabled. It reads cell formulas and imported values without explicitly recalculating or saving the original; OOXML formula caches are read separately from the uploaded ZIP. Missing original caches and formula errors are reported as limitations. Hidden sheets, rows and columns are revealed in review images and labeled in metadata; original print areas are ignored. Sheet/range locators remain stable. Workbooks are bounded to 200,000 cells, 512 columns and 20,000 rows per sheet, and 2,000 review regions; larger workbooks must be split. Preparation and batch failures do not publish a ready material.

Project sources are stored under `DATA_DIR/materials`; Library files are stored under `DATA_DIR/library`. Temporary job workspaces are removed after processing. Incomplete document reviews keep their validated blocks under `DATA_DIR/materials/<id>/reviews/<jobId>` until processing finishes or the saved progress is discarded. Figures cut out of a source are stored with it under `DATA_DIR/materials/<id>/assets`. Transcripts and extracted chunks live in PostgreSQL. Generated study tools keep source snapshots so later grading uses the original evidence and rubric; quizzes and lessons also keep their own copies of the figures they show, their generated illustrations and their voice clips under `DATA_DIR/outputs`. In **Interrupted jobs**, **Resume creation** continues a quiz or lesson from its saved outline and completed parts, or an audio summary or study session from its saved script or plan. **Retry** starts creation again when there is no saved stage, including for overviews. Back up PostgreSQL **and** the persistent data volume together.

Web pages are downloaded by the server, never by Claude. Only `http` and `https` addresses on the public internet are accepted: every address a request resolves to, including each redirect, must be public, so private, loopback, link-local and cloud-metadata addresses are refused and the connection uses exactly the addresses that were checked. A download follows at most 5 redirects, stops after 25 seconds and is limited to 50 MB (or `MAX_UPLOAD_BYTES`, if lower). The server sees only what a plain request receives: pages that need a sign-in, or that build their text in the browser with JavaScript, come back partly readable or unreadable and say so in the source's notes. Retrying a failed web source reads the stored copy and does not download the page again.

Uploads default to 2 GiB per source, using 8 MiB HTTP chunks. Audio is mono signed 16-bit PCM at 24 kHz. Live streams send audio to ElevenLabs' realtime transcription at recording speed; interrupted audio uses ElevenLabs' file transcription before a new live stream starts. Browser support for tab/system audio varies; microphone capture is also available. Recording requires HTTPS outside localhost and browser permission to capture the chosen audio source.

## Coolify Deployment

- Build Pack: **Railpack**
- Base Directory: `/`
- Domain: `https://studyloom.kaufmann.dev`
- Persistent storage mount: `/data`, writable by the application process.
- PostgreSQL: provision a dedicated production database and set `DATABASE_URL`.
- The server applies pending Drizzle migrations on startup before serving traffic, so a fresh database or a fast restart cannot crash on missing tables. The optional Post-Deployment Command `pnpm db:migrate` (executed via `sh -c`) remains as a fallback.
- Keep one replica. Enable WebSocket forwarding and allow at least 10 MiB request bodies in any additional proxy.

`railpack.json` installs FFmpeg, LibreOffice, Poppler, Tesseract (English/German), Python/Pillow and fonts **inside the app image** as runtime Apt packages; the Claude Code binary comes with the npm package. Railpack selects Node and the pinned pnpm version from `package.json`.

Required environment variables:

- `DATABASE_URL`: production PostgreSQL connection string; runtime and deployment migration command.
- `ORIGIN`: `https://studyloom.kaufmann.dev`; build time (embedded as SvelteKit's `paths.origin` for CSRF checks) and runtime.
- `OIDC_ISSUER`: Pocket ID issuer URL; runtime.
- `OIDC_CLIENT_ID`: confidential client ID; runtime.
- `OIDC_CLIENT_SECRET`: confidential client secret; runtime secret.
- `CLAUDE_CODE_OAUTH_TOKEN`: Claude subscription token from `claude setup-token`; runtime secret.
- `ELEVENLABS_API_KEY`: ElevenLabs API key with speech-to-text, text-to-speech and voice read access; transcription, audio summaries, study sessions and lesson voices; runtime secret.
- `DATA_DIR`: set `/data` to use the persistent volume (code default: `.data`).

Optional environment variables:

- `GEMINI_API_KEY`: Google Gemini API key; generated illustrations for lesson slides (Nano Banana 2.1). Without it lessons use the figures of your sources and text slides; runtime secret.
- `MAX_UPLOAD_BYTES`: maximum source size; default `2147483648`.
- `HOST`: bind address; default `0.0.0.0`.
- `PORT`: supplied by Coolify; standalone default `3000`.
- `BODY_SIZE_LIMIT`: Node adapter HTTP body limit; default `10M`.

Application secrets are not needed during the build. Complete the Pocket ID client settings after deploying. No privileged container or host container socket is used.

## Verification

`pnpm test` covers web page address checks and downloads, task urgency, repeating-event expansion, iCalendar feed/export/import, recorder resampling and recovery ordering, session expiry and redirect validation, credential environment isolation, the Claude run options and model list, file sniffing and document units, ElevenLabs transcription turns and the realtime stream, workspace path confinement, citation checks, grading of every answer field including number formats, coverage budgets, outlines and exercise completeness, figure references, the Gemini image client, resumable lesson writing and illustrations, the ElevenLabs client, per-voice request stitching, MP3 joining and inserted silence, answer collection until I'm done, the tutor session's retries, study session resume rules and live feedback parsing; with `TEST_DATABASE_URL` set it also runs the database-backed suites, including source ingestion, the Moodle calendar sync, deferred processing and reprocessing, the conversion of stored quizzes to answer fields, staged quiz and lesson generation, lesson answers and voice clips, resumable audio summaries, study session planning and a complete simulated study session over the socket. `pnpm test:components` runs the browser component tests (Markdown rendering, the question card, the lesson session, and resuming or discarding paused processing). `pnpm check` checks Svelte and TypeScript; `pnpm build` creates both the SvelteKit application and the runtime bundle.

After deployment, verify Pocket ID login/logout, a calendar feed subscription from a phone, microphone and tab capture, pause/resume, interrupted recording recovery, one representative upload and one web page, a cited overview, extraction of a document with figures, formulas and exercises, a quiz and a lesson at Comprehensive coverage (with voice and with a generated illustration), an audio summary, a short study session with headphones (long pauses mid-answer, I'm done, a follow-up, Space to skip, closing the tab and resuming) and quiz grading with your configured services, and connecting the Moodle calendar. Unit tests do not replace those browser/device and deployed-service checks.
