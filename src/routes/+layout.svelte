<script lang="ts">
	import { resolve } from '$app/paths';
	import { onMount } from 'svelte';
	import { ModeWatcher, toggleMode } from 'mode-watcher';
	import { page } from '$app/state';
	import {
		CalendarDays,
		House,
		FolderOpen,
		Library,
		ListTodo,
		Settings,
		SunMoon,
		LogOut,
		Menu
	} from '@lucide/svelte';
	import { Badge } from '#lib/components/ui/badge/index.js';
	import Button from '#lib/components/ui/button/button.svelte';
	import * as Sheet from '#lib/components/ui/sheet/index.js';
	import { Toaster } from '#lib/components/ui/sonner/index.js';
	import favicon from '#lib/assets/favicon.svg';
	import { setTasks, Tasks } from '#lib/tasks.svelte.js';
	import { plural } from '#lib/ui.js';
	import './layout.css';
	let { children } = $props();
	// Sign-in and app consent render as standalone screens without the workspace chrome.
	let bare = $derived(page.url.pathname === '/login');
	let column = $derived(page.route.id === '/projects/[id]' ? 'max-w-[1600px]' : 'max-w-5xl');
	let menuOpen = $state(false);
	const tasks = setTasks(new Tasks());
	const tasksHref = resolve('/tasks');
	const links = [
		{ href: resolve('/'), label: 'Home', icon: House },
		{ href: resolve('/calendar'), label: 'Calendar', icon: CalendarDays },
		{ href: tasksHref, label: 'Tasks', icon: ListTodo },
		{
			href: resolve('projects'),
			label: 'Projects',
			icon: FolderOpen
		},
		{ href: resolve('library'), label: 'Library', icon: Library },
		{ href: resolve('settings'), label: 'Settings', icon: Settings }
	];
	// Nested pages such as a project or a Library folder keep their section highlighted.
	const isCurrent = (href: string) =>
		href === resolve('/') ? page.url.pathname === href : page.url.pathname.startsWith(href);

	onMount(() => {
		if (!bare) void tasks.load();
	});
</script>

<svelte:head><link rel="icon" href={favicon} /><title>Studyloom</title></svelte:head>
<ModeWatcher />
<Toaster position="bottom-right" />
<a
	href="#main"
	class="sr-only focus:not-sr-only focus:absolute focus:z-50 focus:bg-background focus:p-3"
	>Skip to content</a
>
{#snippet signOut(extra: string)}
	<form action="/auth/logout" method="POST">
		<Button type="submit" variant="ghost" class={extra}><LogOut />Sign out</Button>
	</form>
{/snippet}
{#snippet urgentBadge(href: string)}
	{#if href === tasksHref && tasks.urgentCount > 0}
		<Badge variant="destructive" aria-label={`${plural(tasks.urgentCount, 'task')} due now`}>
			{tasks.urgentCount}
		</Badge>
	{/if}
{/snippet}
{#if !bare}
	<header class="border-b bg-background">
		<div class={['mx-auto flex items-center justify-between gap-3 px-4 py-4 sm:px-8', column]}>
			<a href={resolve('/')} class="flex items-center gap-2 text-lg font-semibold tracking-tight"
				><span
					aria-hidden="true"
					class="size-6 shrink-0 bg-foreground"
					style:mask={`url("${favicon}") center / contain no-repeat`}
				></span>

				Studyloom
			</a>

			<nav aria-label="Main navigation" class="hidden items-center gap-1 lg:flex">
				{#each links as link (link.href)}
					<Button
						href={link.href}
						variant="ghost"
						class="aria-[current=page]:bg-muted"
						aria-current={isCurrent(link.href) ? 'page' : undefined}
						><link.icon />{link.label}{@render urgentBadge(link.href)}</Button
					>
				{/each}
				<Button variant="ghost" size="icon" aria-label="Toggle color theme" onclick={toggleMode}
					><SunMoon /></Button
				>
				{@render signOut('')}
			</nav>
			<Sheet.Root bind:open={menuOpen}>
				<Sheet.Trigger>
					{#snippet child({ props })}
						<Button {...props} variant="ghost" size="icon" class="lg:hidden" aria-label="Open menu"
							><Menu /></Button
						>
					{/snippet}
				</Sheet.Trigger>
				<Sheet.Content side="right">
					<Sheet.Header><Sheet.Title>Menu</Sheet.Title></Sheet.Header>
					<nav aria-label="Main navigation" class="flex flex-col gap-1 px-4">
						{#each links as link (link.href)}
							<Button
								href={link.href}
								variant="ghost"
								class="h-11 justify-start aria-[current=page]:bg-muted"
								aria-current={isCurrent(link.href) ? 'page' : undefined}
								onclick={() => (menuOpen = false)}
								><link.icon />{link.label}{@render urgentBadge(link.href)}</Button
							>
						{/each}
						<Button variant="ghost" class="h-11 justify-start" onclick={toggleMode}
							><SunMoon />Toggle theme</Button
						>
						{@render signOut('h-11 w-full justify-start')}
					</nav>
				</Sheet.Content>
			</Sheet.Root>
		</div>
	</header>
{/if}
<main id="main" class={bare ? 'min-h-screen' : ['mx-auto px-4 py-8 sm:px-8', column]}>
	{@render children()}
</main>
