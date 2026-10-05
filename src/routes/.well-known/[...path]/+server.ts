import { error } from '@sveltejs/kit';
import { oauthMetadataResponse } from '@modelcontextprotocol/server';
import { authorizationServerMetadata, MCP_SCOPE, mcpResource } from '#lib/server/oauth.js';
import type { RequestHandler } from './$types';

/** OAuth discovery for MCP clients: protected resource (RFC 9728) and authorization server (RFC 8414). */
export const GET: RequestHandler = ({ request }) =>
	oauthMetadataResponse(request, {
		oauthMetadata: authorizationServerMetadata(),
		resourceServerUrl: new URL(mcpResource()),
		scopesSupported: [MCP_SCOPE],
		resourceName: 'Studyloom'
	}) ?? error(404);
