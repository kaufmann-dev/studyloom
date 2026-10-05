import { OAuthError, OAuthErrorCode } from '@modelcontextprotocol/server';
import { boundedBody } from '#lib/server/endpoints/http.js';
import { oauthFailure, oauthResponse, registerClient } from '#lib/server/oauth.js';
import type { RequestHandler } from './$types';

/** Dynamic client registration (RFC 7591), open to any MCP client. */
export const POST: RequestHandler = async ({ request }) => {
	try {
		let metadata: unknown;
		try {
			metadata = JSON.parse((await boundedBody(request, 16 * 1024)).toString());
		} catch (cause) {
			if (!(cause instanceof SyntaxError)) throw cause;
			throw new OAuthError(OAuthErrorCode.InvalidClientMetadata, 'Send client metadata as JSON.');
		}
		return oauthResponse(await registerClient(metadata), 201);
	} catch (cause) {
		return oauthFailure(cause);
	}
};
