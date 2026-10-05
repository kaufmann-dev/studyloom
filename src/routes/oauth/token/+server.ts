import { OAuthError, OAuthErrorCode } from '@modelcontextprotocol/server';
import { boundedBody } from '#lib/server/endpoints/http.js';
import { exchangeToken, oauthFailure, oauthResponse } from '#lib/server/oauth.js';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = async ({ request }) => {
	try {
		const type = request.headers.get('content-type') ?? '';
		if (!type.toLowerCase().startsWith('application/x-www-form-urlencoded'))
			throw new OAuthError(
				OAuthErrorCode.InvalidRequest,
				'Send the token request as application/x-www-form-urlencoded.'
			);
		const form = new URLSearchParams((await boundedBody(request, 16 * 1024)).toString());
		return oauthResponse(await exchangeToken(form, request.headers.get('authorization')));
	} catch (cause) {
		return oauthFailure(cause);
	}
};
