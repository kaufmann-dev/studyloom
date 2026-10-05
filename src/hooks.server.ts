import { error, redirect } from '@sveltejs/kit';
import type { Handle } from '@sveltejs/kit/hooks';
import { building } from '$app/env';
import { readSession, SESSION_COOKIE, safeReturnTo } from '#lib/server/auth.js';
import { origin } from '#lib/server/config.js';

/** OAuth clients call these without a browser session or Origin; each authenticates itself. */
const isMachinePath = (path: string) =>
	path === '/mcp' ||
	path === '/oauth/token' ||
	path === '/oauth/register' ||
	path.startsWith('/.well-known/');

export const handle: Handle = async ({ event, resolve }) => {
	const path = event.url.pathname;
	if (building) return resolve(event);
	if (isMachinePath(path)) {
		event.locals.session = null;
		return resolve(event);
	}
	const active =
		event.request.headers.get('x-studyloom-interaction') === '1' ||
		event.request.headers.get('sec-fetch-dest') === 'document';
	event.locals.session = await readSession(event.cookies.get(SESSION_COOKIE), active);
	if (
		!['GET', 'HEAD', 'OPTIONS'].includes(event.request.method) &&
		event.request.headers.get('origin') !== origin()
	)
		error(403, 'Invalid origin');
	if (
		!event.locals.session &&
		path !== '/login' &&
		!path.startsWith('/auth/') &&
		// The calendar feed is authorised by the secret token in its path.
		!path.startsWith('/feed/') &&
		path !== '/api/health'
	) {
		if (path.startsWith('/api/')) error(401, 'Please sign in.');
		redirect(303, '/login?returnTo=' + encodeURIComponent(safeReturnTo(path + event.url.search)));
	}
	return resolve(event);
};
