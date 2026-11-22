# Repository Instructions

## Build and Verification

Derive final commands from `package.json`, `pnpm-workspace.yaml`, and `drizzle.config.*`. Use these defaults:

```bash
pnpm install
pnpm dev                     # Local development
pnpm check                   # Run before finishing Svelte/TS changes
pnpm build                   # Run before finishing deployment/routing/server changes
pnpm test                    # If defined in package.json
pnpm exec vitest run         # If Vitest is configured without a test script
pnpm drizzle-kit generate    # Generate schema migrations
pnpm drizzle-kit migrate     # Execute migrations
```

- Always generate and run migrations through Drizzle Kit. Keep schema files and migrations aligned with the project config.

## Tooling

- **Svelte MCP**: Use before writing, reviewing, or refactoring Svelte or SvelteKit code.
  - Call `list-sections` to identify relevant documentation.
  - Fetch all relevant sections with `get-documentation`.
  - After writing Svelte code, run `svelte-autofixer` until it reports no issues or suggestions.
  - Generate a playground link only after the user asks for one, and only when the code was not written into the project.
- **Svelte file-editor**: Use this subagent for Svelte component/module work if available.

## Technology Stack

- **Framework**: SvelteKit with `@sveltejs/adapter-node`
- **UI**: Tailwind CSS and `shadcn-svelte`
- **Icons**: `@lucide/svelte`
- **Theme**: `mode-watcher`
- **Database**: Drizzle with PostgreSQL
- **Auth**: Pocket ID OIDC with `openid-client`; one shared private workspace
- **Forms**: Superforms and Zod
- **Testing**: Vitest

Do not use frameworks or libraries just because they are installed. Keep optional infrastructure out of the project until its feature is being implemented.

## Svelte Implementation Patterns

Always treat this as a Svelte 5 project. Use runes, snippets, and fine-grained reactivity.

### Core State and Props

- Use `$props()` for component inputs. Always treat props as changeable.
- Use `$state` only for values that must update the template, a derived value, or an effect.
- Use `$state.raw` for large objects, API responses, or arrays that are reassigned entirely without deep mutation tracking.
- Use `$derived` for computed state, including values derived from props.
- Use `$derived.by` only when computation requires a multi-line function.

### Reactivity and Effects ($effect)

Never use `$effect` unless absolutely necessary (e.g., syncing with external non-Svelte libraries). Using `$effect` is almost always a sign the code should be refactored.

**❌ Wrong: `$effect` for computed state**

```svelte
let rowsPerPageValue = $state(String(data.query.rows));
$effect(() => {
  rowsPerPageValue = String(data.query.rows);
});
```

**✅ Right: Use `$derived`**

```svelte
let rowsPerPageValue = $derived(String(data.query.rows));
```

**❌ Wrong: `$effect` to react to state changes**

```svelte
let currentPage = $state(data.query.page);
$effect(() => {
  navUpdate({ page: currentPage });
});
<Select bind:value={currentPage} />
```

**✅ Right: React to events at the boundary**

```svelte
let currentPage = $state(data.query.page);
<Select bind:value={currentPage} onValueChange={(value) => navUpdate({ page: value })} />
```

**❌ Wrong: `$effect` for type conversion with `bind:`**

```svelte
let query = $state({ rowsPerPage: 10 });
let rowsPerPageValue = $state(String(query.rowsPerPage));
$effect(() => {
  const n = Number.parseInt(rowsPerPageValue, 10);
  if (!Number.isFinite(n) || n === query.rowsPerPage) return;
  query.rowsPerPage = n;
});
<Select bind:value={rowsPerPageValue} />
```

**✅ Right: Use getter/setter bindings**

```svelte
let query = $state({ rowsPerPage: 10 });
<Select
  bind:value={
    () => query.rowsPerPage.toString(),
    (value) => { query.rowsPerPage = Number.parseInt(value, 10); }
  }
/>
```

**Valid `$effect` Escape Hatch:**
When an effect must write state, track the external source and keep reads of the written target out of the dependency set using `untrack`:

```svelte
import { untrack } from "svelte";

let source = $state(0);
let target = $state(0);

$effect(() => {
  const next = source + 1;
  untrack(() => { target = next; });
});
```

Always write effects as browser-only by nature. For global event listeners, use `<svelte:window>` or `<svelte:document>` rather than `onMount` or an effect.

Use `createSubscriber` from `svelte/reactivity` to observe external sources. Use `$inspect.trace(label)` as the first line of a reactive block to debug update triggers.

If an effect genuinely needs explicit dependency control and the project uses `runed`, consider `watch`. Do not add `runed` only to avoid a small refactor.

### Component Architecture & Styling

Use modern Svelte replacements over legacy features:

- Use snippets and `{@render ...}` for reusable markup and component children.
- Use `<DynamicComponent>` for dynamic component rendering.
- Use `import Self from "./ThisComponent.svelte"` and `<Self>` for recursive rendering.
- Use classes with `$state` fields for shared reactive logic when it fits better than stores.
- Use `{@attach ...}` for new attachment code.
- Use `clsx`-style arrays and objects in `class` attributes for conditional classes.
- Use `onclick={...}` and other `on...` attributes for event listeners.
- Use keyed `{#each}` blocks with stable object identifiers. Never use the index as a key. Avoid destructuring if mutating the item.
- Use CSS custom properties for parent-to-child styling boundaries.
- Use `createContext` for typed context instead of unscoped shared module state when state must be per request or per tree.
- Enable `compilerOptions.experimental.async` in the `sveltekit()` plugin options in `vite.config.ts` to use `await` expressions and `hydratable` (requires Svelte >= 5.36).

### Legacy Features to Avoid in New Code

Avoid these legacy Svelte features in new or refactored code:

- `export let`, `$$props`, `$$restProps`
- `$: ` reactive blocks or assignments
- `<slot>`, `$$slots`, `<svelte:fragment>`
- `<svelte:component>` and `<svelte:self>`
- `use:action`
- `class:` directives
- `on:` event attributes (e.g., `on:click`)

## UI and Styling

- **shadcn-svelte**: All components are already pre-installed in `src/lib/components/ui/`. **Never run the CLI to install components, and never delete unused shadcn components during codebase cleanup.**
  - Never import components from a package named `shadcn-svelte`.
  - Import them only from local `#lib/components/ui/...` paths (SvelteKit 3 subpath imports, with explicit `.js`/`.svelte` extensions).
  - Use local component source as the final source of truth once a component has been copied into the project.
  - Customize with Tailwind classes using `class` and the local `cn()` helper.
- Available shadcn-svelte components: `accordion alert alert-dialog aspect-ratio avatar badge breadcrumb button calendar card carousel chart checkbox collapsible combobox command context-menu data-table date-picker dialog drawer dropdown-menu form hover-card input input-otp label menubar navigation-menu pagination popover progress radio-group range-calendar resizable scroll-area select separator sheet sidebar skeleton slider sonner switch table tabs textarea toggle toggle-group tooltip`
- **Icons**: Always use `@lucide/svelte` (e.g., `<Search class="size-4" />`).
- **Theming**: Use `setMode("light" | "dark" | "system")` or `toggleMode` from `mode-watcher` for controls. Add `ModeWatcher` once in the root layout:
  ```svelte
  <script lang="ts">
  	import { ModeWatcher } from 'mode-watcher';
  	let { children } = $props();
  </script>

  <ModeWatcher />
  {@render children()}
  ```

## Backend and Services

- **Authentication**: Use `src/lib/server/auth.ts` and `openid-client`. Pocket ID's access policy is the sole admission control. Use S256 PKCE, `client_secret_post`, opaque hashed server sessions, 24-hour idle and seven-day absolute expiry, and RP-Initiated Logout. Never introduce local passwords, refresh-token sessions, identity allowlists or a development auth bypass. Passive polling and recording traffic must not extend idle time.
- **Forms**: Always use Superforms with Zod. Follow the chain: `zod schema -> superforms -> formsnap -> shadcn-svelte form components`. Use `Form.Field`, `Form.Control`, and shadcn error components rather than ad hoc markup.

## Local Database and Deployment

- **Database**: Use the manually managed Podman PostgreSQL database named `postgres-sveltekit` for local development. Treat production database provisioning as separate infrastructure.
- **Debugging**: Keep deployment fixes scoped to the exact failing layer. Identify the failing command first in Coolify or Railpack before fixing it.

For Coolify and Railpack:

- If `pnpm-workspace.yaml` exists in a single-package app, keep a non-empty `packages` list with `.` included.
- Use `engines.node` to pin compatible Node behavior when dependencies require a minimum patch version. Railpack reads it as the runtime version; do not duplicate it in `railpack.json`.
- Read deployment environment variables from `process.env`. Load `.env` only after checking that the file exists.
- Let Railpack handle the install phase unless a project-specific reason requires otherwise.
- Prefer explicit deploy or runtime migration and seed steps when Coolify supports them.
- Keep build-time migration and seed scripts idempotent when they must run during image builds.

## Studyloom Architecture

- `src/lib/domain.ts` owns shared types and Zod schemas. Keep API contracts and UI aligned.
- `src/lib/server/api.ts` dispatches authenticated HTTP endpoints to the per-resource handlers in `src/lib/server/endpoints/`. Never return job payloads, source snapshots, credentials or private filesystem paths in API responses.
- The interface is English only; write UI strings inline.
- Model-written text (chat answers, summaries, extracted sources, slides, question bodies) renders through `renderMarkdown` in `src/lib/markdown.ts` (`Markdown.svelte`, `QuestionCard.svelte`): marked with KaTeX for `$…$`/`$$…$$`, DOMPurify, and Mermaid fences drawn by a lazily imported `mermaid`. The only images kept are stored ones: `asset:<uuid>` (a source figure; source chunks only) and `image:<id>` (an output's own copy), rewritten to `/api/assets/…/file` and `/api/outputs/…/images/…`. Never use `{@html}` on model text any other way, and never let rendered text load another address.
- Project pages: `src/routes/projects/[id]/+layout.svelte` keys `ProjectShell.svelte` by project; the shell provides `ProjectState` (`src/lib/project.svelte.ts`: the polled workspace, Claude models, the sources selected for chat and study tools, and the recorder, which keeps running between the project's pages). Pages: Sources (`SourcesTable`, `AddSources`), `sources/[materialId]` (`SourceViewer`: original beside extracted content), `study` (`OutputList`, `GenerateForm`), `outputs/[outputId]` (`OutputViewer`), `chat`, `schedule`. `GET /api/projects/:id` returns per-source counts and output summaries only; a whole output comes from `GET /api/outputs/:id`.
- Browser code calls the API through `api()` in `src/lib/ui.ts`; job polling, chunked uploads and pins live in `src/lib/polling.ts`, `src/lib/upload.ts` and `src/lib/pins.svelte.ts`. Reuse them instead of calling `fetch` in components.
- Tasks and calendar: dates and times are zone-less wall-clock values (`YYYY-MM-DD`, `HH:MM`). Urgency is computed only in the browser (`src/lib/tasks.ts`); repeat expansion and date maths live in `src/lib/calendar.ts`. Reuse the shared `Tasks` context (`src/lib/tasks.svelte.ts`, provided by the root layout) and the `Events` range store (`src/lib/calendar.svelte.ts`). Red is reserved for task urgency.
- iCalendar is written in `src/lib/server/ics.ts` and read in `src/lib/server/ics-import.ts`, without a calendar library. Only the feed (expanded occurrences in UTC, using the feed's time zone) and import (UTC or zoned times into wall-clock) convert between instants and wall-clock; the file export uses floating local times and repeat rules.
- Moodle calendar: `src/lib/server/moodle.ts` owns the sync (on connect, every 30 minutes from `src/server/runtime.ts`, and on demand), downloading through `fetchWebPage` and parsing with `parseIcs`. Events and tasks carry `source` (`custom` or `moodle`); Moodle entries without a duration become tasks. Moodle items are read-only (the event and task endpoints answer 409) except ticking a task off, which the sync never overwrites; they are left out of the file export and skipped by imports. The Moodle URL holds an authentication token: store it only in `moodle_calendar`, never return or log it (the API returns only its host).
- The only route without a browser session is `/feed/<token>/studyloom.ics` (the feed token alone authorises it; `/api/calendar/feed` is the only API response that returns it), allowed in `src/hooks.server.ts`.
- `src/server/runtime.ts` attaches the authenticated recording and study session WebSockets (`src/server/study-socket.ts`) and starts durable workers. `server.mjs` is the production entrypoint; Vite alone does not run recording sockets or workers.
- Web page sources: `addWebSource` in `src/lib/server/sources.ts` downloads the page with `src/lib/server/web-page.ts` and stores the HTML as the material's original (`sourceUrl` records the address), then queues the normal `ingest` job unless processing was put off. Only the server downloads, and only public addresses: the lookup is pinned and re-checked on every redirect. Never give Claude or its commands network fetching for this, and never loosen the address check.
- `src/lib/server/jobs.ts` runs the three job queues (`interactive`, `background`, and `speech` for lesson voicing) and handles ingestion, chat, overviews, quizzes, lessons, grading and recovery. Keep source snapshots (`Snapshot`: chunks with their `kind`, plus the source's figures) and validated citations (`src/lib/server/citations.ts`; quotes are compared after collapsing whitespace). Preserve idempotency when retrying jobs. `settleJobTarget` is the one place that says what a failed, cancelled or retried job does to its source, quiz attempt or lesson answer.
- Deferred processing: an upload or web page can be stored without extraction (status `stored`, "Not processed"). `POST /api/materials/:id/process` starts, retries or redoes extraction; it refuses while an active job's `payload.materialIds` contains the source. Reprocessing replaces chunks and assets only when the new result is saved, and a failed or cancelled reprocess restores the earlier status (`payload.previous`).
- Coverage: generated study tools take `coverage` (`light`, `standard`, `comprehensive`), never a length or a count. `coverageBudget` in `src/lib/domain.ts` derives the target size from the snapshot (`sourceStats`); at `comprehensive` every source exercise (chunks of kind `exercise`) must be asked, which the outline and the per-part checks enforce.
- Questions: quizzes and lessons share `questionSchema`: a Markdown `body` holding each answer field as `{{id}}` exactly once (in a sentence, a list or a table cell) and `fields` of type `select`, `multiselect`, `toggle`, `text`, `number` or `essay`. Matching, classification, yes/no matrices, true/false lists and calculation tables are all tables of fields. `src/lib/server/grading.ts` grades everything but `essay` without Claude (`parseNumber` reads German and English number formats); only essay fields go to the `grade` job (`gradeEssays`). `QuestionCard.svelte` replaces placeholders after sanitising and mounts `FieldInput.svelte` into them. A new field type is one schema branch, one grader case and one input. Wrong answers use the `warning` token and icons, never red.
- Staged generation: `src/lib/server/outline.ts` plans an outline of parts and sections (with the chunks and exercises each covers), then quizzes and lessons are written one part per Claude call. Finished stages are kept in `DATA_DIR/outputs/<jobId>/plan.json` (the job workspace is wiped on every run), so a retry pays for nothing twice; a rejected part goes back to Claude once with the reason (`checked`). Outputs keep their own files under `DATA_DIR/outputs/<outputId>`: `images/` (source figures copied from the job workspace and generated illustrations) and `clips/`.
- Lessons: `src/lib/server/lesson.ts` writes chapters of sections; a section is one to five beats (a slide and its narration) followed by questions. Slides are a lesson image or Markdown content. Answers go to `lesson_answers` (`POST /api/outputs/:id/answers`); closed questions are graded at once and answered with the feedback Claude wrote in advance (`feedback.correct` / `feedback.incorrect`), written answers by the `grade` job. `LessonSession` (`src/lib/study/lesson.svelte.ts`) holds the learner's place, answers and audio; `LessonPlayer.svelte` shows it.
- Lesson voice: optional and chosen per lesson (off, on demand, everything now; changeable later). `src/lib/server/lesson-voice.ts` voices a clip the first time it is asked for and stores it under `clips/`; `POST /api/outputs/:id/clips/:key` voices, `GET` only serves what exists, so reading never spends credits. Clip keys are looked up in the lesson or answer, never joined into a path unchecked. A `voice` job on the `speech` queue pre-voices all explanations.
- Illustrations: `src/lib/server/gemini.ts` generates lesson slides with Nano Banana 2.1 through Google's Interactions API, only where no figure of the sources fits and only when the lesson asked for it. `GEMINI_API_KEY` stays in that module, never in Claude, commands or browser code; pictures already on disk are not generated again.
- Claude: `src/lib/server/claude.ts` is the only user of `@anthropic-ai/claude-agent-sdk`. Runs use `tools: []` (no built-in Claude Code tools), `settingSources: []`, `permissionMode: 'dontAsk'` and the in-process `studyloom` MCP tools (`workspaceTools`: run_command, read_file, view_image, crop_image, transcribe_audio), never Bash or web tools. The Claude Code process gets only `claudeEnvironment()`, whose single secret is `CLAUDE_CODE_OAUTH_TOKEN`; there is no login UI and no API-key path. Models come live from `supportedModels()`: store the alias (`default`, `opus`, …), never a pinned version, and treat unknown stored IDs via `gradingModel`. Generation jobs return structured output (`claudeResult` with a Zod schema); only ingestion writes file artifacts (validated review batches or `extracted.json` through `runClaudeWithArtifact`).
- Ingestion: `src/lib/server/extract.ts` sniffs the original by content, never by extension. Plain text (`textSections`) and audio/video (FFmpeg + ElevenLabs `transcribeFile`) are stored without Claude; PDFs and Office/OpenDocument documents render every page and use sequential visual review batches of at most eight units with required image delivery and validated page-owned chunks (the server assigns chunk and figure locators from the unit); spreadsheets use `scripts/prepare-spreadsheet.py` through `/usr/bin/python3` and deployment `python3-uno` for cell/formula metadata plus rendered sheet regions in the same review pipeline. Preserve sheet/range locators, original-cache versus imported-value provenance, and preparation limitations. Do not save the original or enable macros/external-link updates. Document and workbook preparation failures fail the job; markup, images, unknown formats and other preparation failures use the agentic prompt. Interrupted ingestion restarts from scratch. Server tools run through `runTool`, Claude's commands through `runCommand` (`src/lib/server/commands.ts`), both with the workspace as cwd and a secrets-free environment.
- Extraction format (`EXTRACTION_FORMAT` in `src/lib/server/jobs.ts`): what Claude extracts is Markdown (`materials.content_format`; text files, pasted text and transcripts stay `plain`): GFM tables, LaTeX math, Mermaid for diagrams whose structure is exact, and figures cut out with the `crop_image` tool (`src/lib/server/figures.ts`, FFmpeg) and referenced as `figure:<path>`, which `saveIngestion` stores as assets and rewrites to `asset:<uuid>`. Every source exercise is its own chunk of kind `exercise`, answer keys are kind `solution` with visual marks written out (`- [x]`, `X`). `validatePages` requires every figure reference to have its asset and every asset to be shown.
- Audio summaries: Claude writes a cited script of speaker turns (`audioScriptSchema(style)`: a narration, or a tutor and learner dialogue), then `voiceClips` in `src/lib/server/voicing.ts` voices it turn by turn through `src/lib/server/elevenlabs.ts`, each speaker in their own voice and stitched only to earlier requests in that voice, using the voices and speech model the user picked from the account's live lists. Thinking pauses and speaker changes become silent MP3 frames from `silenceMp3` in `src/lib/server/audio.ts`; never re-encode. Parts and the script stay under `DATA_DIR/audio/<jobId>` until the output is saved, so retries never pay twice. `ELEVENLABS_API_KEY` stays in that module, never in Claude, commands or browser code.
- Transcription is ElevenLabs only: `transcribeFile` in `src/lib/server/elevenlabs.ts` (batch, with speaker labels; uploads and recording recovery) and `src/lib/server/realtime-asr.ts` (realtime, VAD-committed segments, no speaker labels; recordings and study sessions). The Scribe model IDs are constants there because ElevenLabs lists no transcription models.
- Study sessions: a `session` job has Claude write a cited plan (`studyPlanSchema`) and voices its intro, explanations and questions as PCM clips under `DATA_DIR/audio/<outputId>/parts`. `src/server/study-socket.ts` runs a session: it plays the clips, listens through `src/lib/server/realtime-asr.ts` (shared with recordings), collects an answer with `AnswerCollector` (`src/lib/server/study-run.ts`) until the learner presses I'm done (pauses never end an answer), and streams Claude's graded reply through `TutorConversation` (`src/lib/server/tutor.ts`) into `speakStream`. Each run has one tool-less `ClaudeConversation`; the primer (plan, cited excerpts, answers so far) is its system prompt, so a failed turn restarts the session from the saved answers and retries once if nothing was spoken. Runs and answers live in `study_runs` and `study_answers`; feedback is saved before it is confirmed as played, so a resumed run says it again exactly once. The browser opens the microphone only while the tutor listens; answer audio is never stored.
- Browser audio is 24 kHz signed 16-bit mono PCM. Persist and acknowledge chunks before discarding them; retain exact sample offsets. Never replay recovery backlog into a live stream faster than real time.
- Native processing packages belong in `railpack.json` (`deploy.aptPackages`), inside the deployed app image. Their absence from a development terminal does not block implementation, type checks, unit tests or builds.
- Generate migrations with `pnpm db:generate` and apply with `pnpm db:migrate`. Run a single application replica with persistent PostgreSQL and `/data` storage.
- Run `pnpm check`, `pnpm test` and `pnpm build` before finishing changes to these flows. Native/browser integration checks run where the required runtime and configured services exist; report their actual coverage.
