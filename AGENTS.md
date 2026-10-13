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
- **Debugging**: Keep deployment fixes scoped to the exact failing layer. Identify the failing command first in Coolify or Nixpacks before fixing it.

For Coolify and Nixpacks:

- If `pnpm-workspace.yaml` exists in a single-package app, keep a non-empty `packages` list with `.` included.
- Use `engines.node` and `nixpacks.toml` to pin compatible Node behavior when dependencies require a minimum patch version.
- Read deployment environment variables from `process.env`. Load `.env` only after checking that the file exists.
- Let Nixpacks handle the install phase unless a project-specific reason requires otherwise.
- Prefer explicit deploy or runtime migration and seed steps when Coolify supports them.
- Keep build-time migration and seed scripts idempotent when they must run during image builds.

## Studyloom Architecture

- `src/lib/domain.ts` owns shared types and Zod schemas. Keep API contracts and UI aligned.
- `src/lib/server/api.ts` dispatches authenticated HTTP endpoints to the per-resource handlers in `src/lib/server/endpoints/`. Never return job payloads, source snapshots, credentials or private filesystem paths in API responses.
- The interface is English only; write UI strings inline.
- Model-written text (chat answers, summaries) renders through `Markdown.svelte`, which sanitises the HTML. Never use `{@html}` on it directly.
- Browser code calls the API through `api()` in `src/lib/ui.ts`; job polling, chunked uploads and pins live in `src/lib/polling.ts`, `src/lib/upload.ts` and `src/lib/pins.svelte.ts`. Reuse them instead of calling `fetch` in components.
- Tasks and calendar: dates and times are zone-less wall-clock values (`YYYY-MM-DD`, `HH:MM`). Urgency is computed only in the browser (`src/lib/tasks.ts`); repeat expansion and date maths live in `src/lib/calendar.ts`. Reuse the shared `Tasks` context (`src/lib/tasks.svelte.ts`, provided by the root layout) and the `Events` range store (`src/lib/calendar.svelte.ts`). Red is reserved for task urgency.
- iCalendar is written in `src/lib/server/ics.ts` and read in `src/lib/server/ics-import.ts`, without a calendar library. Only the feed (expanded occurrences in UTC, using the feed's time zone) and import (UTC or zoned times into wall-clock) convert between instants and wall-clock; the file export uses floating local times and repeat rules.
- Routes without a browser session: `/feed/<token>/studyloom.ics` (the feed token alone authorises it; `/api/calendar/feed` is the only API response that returns it), and the MCP/OAuth machine paths `/mcp` (bearer access token), `/oauth/token`, `/oauth/register` and `/.well-known/*`, listed in `src/hooks.server.ts`.
- The hosted MCP server is `/mcp` (`@modelcontextprotocol/server` v2, `createMcpHandler`). `src/lib/server/oauth.ts` is its OAuth 2.1 authorization server: dynamic registration, S256 PKCE, consent at `/oauth/authorize` after Pocket ID sign-in, opaque hashed tokens (1 h access, 30-day rotating refresh), revocation under Settings. Refresh tokens exist only for MCP grants, never for browser sessions. Tools live in `src/lib/server/mcp/` and call the operations exported by the endpoint modules and `src/lib/server/sources.ts`; never return snapshots, job payloads, paths or token hashes.
- `src/server/runtime.ts` attaches authenticated WebSockets and starts durable workers. `server.mjs` is the production entrypoint; Vite alone does not run recording sockets or workers.
- Web page sources: `addWebSource` in `src/lib/server/sources.ts` downloads the page with `src/lib/server/web-page.ts` and stores the HTML as the material's original (`sourceUrl` records the address), then queues the normal `ingest` job. Only the server downloads, and only public addresses: the lookup is pinned and re-checked on every redirect. Never give Muse or its commands network fetching for this, and never loosen the address check.
- `src/lib/server/jobs.ts` handles ingestion, chat, overviews, quizzes, grading and recovery. Keep source snapshots and validated citations. Preserve idempotency when retrying jobs.
- Muse selects conversion commands through `src/server/muse-tools.ts` (stdio MCP for Muse jobs); do not introduce a file-extension conversion dispatcher. Commands run directly via `src/lib/server/commands.ts` with the workspace as cwd and a secrets-free environment.
- Muse text tasks use the persistent subscription profile under `DATA_DIR/muse-config`. Never pass `META_API_KEY` to Muse. `TRANSCRIPTION_API_KEY` belongs only to the transcription broker, never to conversion commands or browser code.
- Audio summaries: Muse writes a cited narration (`audioScriptSchema`), then `src/lib/server/elevenlabs.ts` voices it paragraph by paragraph with request stitching in the voice and speech model the user picked from the account's live lists. Parts and the script stay under `DATA_DIR/audio/<jobId>` until the output is saved, so retries never pay twice. `ELEVENLABS_API_KEY` stays in that module, never in Muse, commands or browser code.
- Browser audio is 24 kHz signed 16-bit mono PCM. Persist and acknowledge chunks before discarding them; retain exact sample offsets. Never replay recovery backlog into a live stream faster than real time.
- Native processing packages belong in `nixpacks.toml`, inside the deployed app image. Their absence from a development terminal does not block implementation, type checks, unit tests or builds.
- Generate migrations with `pnpm db:generate` and apply with `pnpm db:migrate`. Run a single application replica with persistent PostgreSQL and `/data` storage.
- Run `pnpm check`, `pnpm test` and `pnpm build` before finishing changes to these flows. Native/browser integration checks run where the required runtime and configured services exist; report their actual coverage.
