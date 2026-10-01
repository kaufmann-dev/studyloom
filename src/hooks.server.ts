import { error, redirect, type Handle } from '@sveltejs/kit';
import { building } from '$app/environment';
import { readSession, SESSION_COOKIE, safeReturnTo } from '$lib/server/auth';
import { origin } from '$lib/server/config';
export const handle: Handle = async ({ event, resolve }) => {
	const path = event.url.pathname;
	if (!building) {
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
			path !== '/api/health'
		) {
			if (path.startsWith('/api/')) error(401, 'Please sign in.');
			redirect(303, '/login?returnTo=' + encodeURIComponent(safeReturnTo(path + event.url.search)));
		}
	}
	return resolve(event);
};
