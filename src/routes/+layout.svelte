<script lang="ts">
	import { resolve } from '$app/paths';
	import { ModeWatcher, toggleMode } from 'mode-watcher';
	import { page } from '$app/state';
	import { House, FolderOpen, Library, Settings, SunMoon, LogOut } from '@lucide/svelte';
	import Button from '$lib/components/ui/button/button.svelte';
	import favicon from '$lib/assets/favicon.svg';
	import './layout.css';
	let { children } = $props();
	let isLogin = $derived(page.url.pathname === '/login');
</script>

<svelte:head><link rel="icon" href={favicon} /><title>Studyloom</title></svelte:head>
<ModeWatcher />
<a
	href="#main"
	class="sr-only focus:not-sr-only focus:absolute focus:z-50 focus:bg-background focus:p-3"
	>Skip to content</a
>
{#if !isLogin}
	<header class="border-b bg-background">
		<div
			class="mx-auto flex max-w-[1600px] flex-wrap items-center justify-between gap-3 px-4 py-4 sm:px-8"
		>
			<a href={resolve('/')} class="flex items-center gap-2 text-lg font-semibold tracking-tight"
				><span
					aria-hidden="true"
					class="size-6 shrink-0 bg-foreground"
					style:mask={`url("${favicon}") center / contain no-repeat`}
				></span>Studyloom</a
			>
			<nav aria-label="Main navigation" class="flex items-center gap-2">
				<Button href={resolve('/')} variant="ghost"><House />Home</Button>
				<Button href={resolve('/projects')} variant="ghost"><FolderOpen />Projects</Button>
				<Button href={resolve('/library')} variant="ghost"><Library />Library</Button>
				<Button href={resolve('/settings')} variant="ghost"
					><Settings /><span class="hidden sm:inline">Settings</span></Button
				>
				<Button variant="ghost" size="icon" aria-label="Toggle color theme" onclick={toggleMode}
					><SunMoon /></Button
				>
				<form action="/auth/logout" method="POST">
					<Button type="submit" variant="ghost" aria-label="Sign out"
						><LogOut /><span class="hidden sm:inline">Sign out</span></Button
					>
				</form>
			</nav>
		</div>
	</header>
{/if}
<main id="main" class={isLogin ? 'min-h-screen' : 'mx-auto max-w-[1600px] px-4 py-8 sm:px-8'}>
	{@render children()}
</main>
