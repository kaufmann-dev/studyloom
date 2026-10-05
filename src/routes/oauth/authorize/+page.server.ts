import { error, redirect } from '@sveltejs/kit';
import { deniedLocation, issueCode, parseAuthorizationRequest } from '#lib/server/oauth.js';
import type { Actions, PageServerLoad } from './$types';

/** The validated request in the query; invalid ones end here or go back to the client. */
async function authorization(url: URL) {
	const result = await parseAuthorizationRequest(url.searchParams);
	if (result.kind === 'fatal') error(400, result.message);
	if (result.kind === 'redirect') redirect(303, result.location, { external: true });
	return result.request;
}

export const load: PageServerLoad = async ({ url, setHeaders }) => {
	const request = await authorization(url);
	// The consent buttons must never be framed by another site.
	setHeaders({ 'x-frame-options': 'DENY', 'content-security-policy': "frame-ancestors 'none'" });
	const target = new URL(request.redirectUri);
	return { clientName: request.clientName, redirectHost: target.host || target.protocol };
};

export const actions: Actions = {
	allow: async ({ url, locals }) => {
		const request = await authorization(url);
		if (!locals.session) error(401, 'Please sign in.');
		redirect(303, await issueCode(request, locals.session), { external: true });
	},
	deny: async ({ url }) =>
		redirect(303, deniedLocation(await authorization(url)), { external: true })
};
