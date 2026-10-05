import {
	createMcpHandler,
	getOAuthProtectedResourceMetadataUrl,
	requireBearerAuth
} from '@modelcontextprotocol/server';
import { createMcpServer } from '#lib/server/mcp/server.js';
import { MCP_SCOPE, mcpResource, verifyAccessToken } from '#lib/server/oauth.js';
import type { RequestHandler } from './$types';

/** Serves the 2026-07-28 protocol and, statelessly, 2025-era clients. */
const handler = createMcpHandler(({ authInfo }) => createMcpServer(authInfo));

// Created on first use: the resource URL comes from ORIGIN, which exists only at runtime.
let gate: ReturnType<typeof requireBearerAuth> | undefined;

/** Every request needs a live access token; missing or revoked ones get a 401 naming the metadata. */
export const POST: RequestHandler = async ({ request }) => {
	gate ??= requireBearerAuth({
		verifier: { verifyAccessToken },
		requiredScopes: [MCP_SCOPE],
		resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(new URL(mcpResource()))
	});
	const auth = await gate(request);
	return auth instanceof Response ? auth : handler.fetch(request, { authInfo: auth });
};

const methodNotAllowed: RequestHandler = () =>
	new Response(null, { status: 405, headers: { allow: 'POST' } });
export const GET = methodNotAllowed;
export const DELETE = methodNotAllowed;
