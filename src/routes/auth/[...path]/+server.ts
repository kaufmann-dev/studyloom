import { redirect, error } from '@sveltejs/kit';
import { startLogin, finishLogin, logout } from '$lib/server/auth';
import { origin } from '$lib/server/config';
import type { RequestHandler } from './$types';
export const GET: RequestHandler = async ({ params, cookies, url }) => {
	let destination: string;
	if (params.path === 'start')
		destination = await startLogin(cookies, url.searchParams.get('returnTo'));
	else if (params.path === 'callback') {
		try {
			destination = await finishLogin(cookies, url);
		} catch {
			destination = '/login?error=Login%20failed.%20Please%20try%20again.';
		}
	} else if (params.path === 'logout/callback') destination = '/login';
	else error(404);
	redirect(303, destination);
};
export const POST: RequestHandler = async ({ params, cookies, request }) => {
	if (params.path !== 'logout') error(404);
	if (request.headers.get('origin') !== origin()) error(403, 'Invalid origin');
	redirect(303, await logout(cookies));
};
