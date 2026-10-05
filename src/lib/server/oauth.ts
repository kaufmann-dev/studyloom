import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { and, desc, eq, gt, isNull, lt } from 'drizzle-orm';
import { z } from 'zod';
import {
	OAuthError,
	OAuthErrorCode,
	type AuthInfo,
	type OAuthMetadata
} from '@modelcontextprotocol/server';
import { db } from './db';
import * as t from './db/schema';
import { hashToken } from './auth';
import { ClientError, origin } from './config';
import { idSchema, type Connection } from '../domain';

/** The single scope: an MCP connection reaches the whole shared workspace. */
export const MCP_SCOPE = 'studyloom';
export const mcpResource = () => origin() + '/mcp';

const CODE_TTL = 10 * 60_000;
const ACCESS_TTL = 60 * 60_000;
const REFRESH_TTL = 30 * 86400_000;
const UNUSED_CLIENT_TTL = 86400_000;
const AUTH_METHODS = ['none', 'client_secret_post', 'client_secret_basic'] as const;
const LOOPBACK_HOSTS = ['localhost', '127.0.0.1', '[::1]'];
const PKCE_VALUE = /^[A-Za-z0-9._~-]{43,128}$/;
const NO_STORE = { 'cache-control': 'no-store', pragma: 'no-cache' };

type Client = typeof t.oauthClients.$inferSelect;
const newToken = () => randomBytes(32).toString('base64url');

export function authorizationServerMetadata(): OAuthMetadata {
	const issuer = origin();
	return {
		issuer,
		authorization_endpoint: `${issuer}/oauth/authorize`,
		token_endpoint: `${issuer}/oauth/token`,
		registration_endpoint: `${issuer}/oauth/register`,
		scopes_supported: [MCP_SCOPE],
		response_types_supported: ['code'],
		grant_types_supported: ['authorization_code', 'refresh_token'],
		token_endpoint_auth_methods_supported: [...AUTH_METHODS],
		code_challenge_methods_supported: ['S256'],
		authorization_response_iss_parameter_supported: true
	};
}

/** https anywhere, http only on loopback, or a reverse-domain private-use scheme (RFC 8252). */
export function validRedirectUri(value: string) {
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		return false;
	}
	if (value.includes('#') || url.username || url.password) return false;
	if (url.protocol === 'https:') return Boolean(url.hostname);
	if (url.protocol === 'http:') return LOOPBACK_HOSTS.includes(url.hostname);
	return /^[a-z][a-z0-9+-]*(\.[a-z0-9+-]+)+:$/.test(url.protocol);
}

/** Exact match, except that native apps may pick any loopback port at request time (RFC 8252 §7.3). */
export function redirectMatches(registered: string, requested: string) {
	if (registered === requested) return true;
	try {
		const a = new URL(registered);
		const b = new URL(requested);
		return (
			a.protocol === 'http:' &&
			b.protocol === 'http:' &&
			LOOPBACK_HOSTS.includes(a.hostname) &&
			a.hostname === b.hostname &&
			a.pathname === b.pathname &&
			a.search === b.search &&
			!requested.includes('#') &&
			!b.username &&
			!b.password
		);
	} catch {
		return false;
	}
}

export function pkceMatches(verifier: string, challenge: string) {
	return (
		PKCE_VALUE.test(verifier) &&
		createHash('sha256').update(verifier).digest('base64url') === challenge
	);
}

/** Absent, or naming this MCP endpoint (RFC 8707). */
function resourceAllowed(params: URLSearchParams) {
	const own = mcpResource();
	return params
		.getAll('resource')
		.every((value) => value.replace(/#.*$/, '').replace(/\/$/, '') === own);
}

export function oauthResponse(body: unknown, status = 200) {
	return Response.json(body, { status, headers: NO_STORE });
}
/** Answers OAuth errors in the RFC 6749 format; anything else is rethrown. */
export function oauthFailure(cause: unknown) {
	if (!(cause instanceof OAuthError)) throw cause;
	return Response.json(cause.toResponseObject(), {
		status: cause.code === OAuthErrorCode.InvalidClient ? 401 : 400,
		headers: NO_STORE
	});
}

const registrationInput = z.object({
	redirect_uris: z
		.array(z.string().max(2000).refine(validRedirectUri, 'Unsupported redirect URI.'))
		.min(1)
		.max(10),
	client_name: z.string().max(200).optional(),
	token_endpoint_auth_method: z.enum(AUTH_METHODS).default('client_secret_basic'),
	grant_types: z
		.array(z.string())
		.optional()
		.refine(
			(types) =>
				!types ||
				(types.includes('authorization_code') &&
					types.every((type) => ['authorization_code', 'refresh_token'].includes(type))),
			'Only authorization_code and refresh_token grants are supported.'
		),
	response_types: z
		.array(z.string())
		.optional()
		.refine(
			(types) => !types || (types.length === 1 && types[0] === 'code'),
			'Only the code response type is supported.'
		)
});

/** Dynamic client registration (RFC 7591). */
export async function registerClient(body: unknown) {
	const parsed = registrationInput.safeParse(body);
	if (!parsed.success) {
		const issue = parsed.error.issues[0];
		throw new OAuthError(
			issue.path[0] === 'redirect_uris'
				? OAuthErrorCode.InvalidRedirectUri
				: OAuthErrorCode.InvalidClientMetadata,
			issue.message
		);
	}
	const input = parsed.data;
	const secret = input.token_endpoint_auth_method === 'none' ? undefined : newToken();
	// Registration is open, so registrations that never led to a consent do not accumulate.
	await db()
		.delete(t.oauthClients)
		.where(
			and(
				isNull(t.oauthClients.authorizedAt),
				lt(t.oauthClients.createdAt, new Date(Date.now() - UNUSED_CLIENT_TTL))
			)
		);
	const [client] = await db()
		.insert(t.oauthClients)
		.values({
			id: newToken(),
			secretHash: secret ? hashToken(secret) : null,
			authMethod: input.token_endpoint_auth_method,
			name: input.client_name?.trim() || 'MCP client',
			redirectUris: input.redirect_uris
		})
		.returning();
	return {
		client_id: client.id,
		client_id_issued_at: Math.floor(client.createdAt.getTime() / 1000),
		client_name: client.name,
		redirect_uris: client.redirectUris,
		grant_types: ['authorization_code', 'refresh_token'],
		response_types: ['code'],
		token_endpoint_auth_method: client.authMethod,
		scope: MCP_SCOPE,
		...(secret ? { client_secret: secret, client_secret_expires_at: 0 } : {})
	};
}

export interface AuthorizationRequest {
	clientId: string;
	clientName: string;
	redirectUri: string;
	state: string | null;
	codeChallenge: string;
}
export type AuthorizationResult =
	| { kind: 'fatal'; message: string }
	| { kind: 'redirect'; location: string }
	| { kind: 'ok'; request: AuthorizationRequest };

function redirectTo(redirectUri: string, params: Record<string, string | null>) {
	const url = new URL(redirectUri);
	for (const [key, value] of Object.entries(params)) if (value) url.searchParams.set(key, value);
	return url.href;
}

/**
 * Validates an authorization request. Problems with the client or its redirect URI are shown to
 * the user and never redirected; everything else is reported back to the client (RFC 6749 §4.1.2.1).
 */
export function checkAuthorizationRequest(
	params: URLSearchParams,
	client: Pick<Client, 'id' | 'name' | 'redirectUris'> | undefined
): AuthorizationResult {
	if (!client)
		return {
			kind: 'fatal',
			message: 'This application is not registered. Connect it again from the application.'
		};
	const redirectUri = params.get('redirect_uri') ?? '';
	if (!client.redirectUris.some((registered) => redirectMatches(registered, redirectUri)))
		return {
			kind: 'fatal',
			message: 'The return address is not registered for this application.'
		};
	const state = params.get('state');
	const fail = (error: OAuthErrorCode, description: string): AuthorizationResult => ({
		kind: 'redirect',
		location: redirectTo(redirectUri, {
			error,
			error_description: description,
			state,
			iss: origin()
		})
	});
	if (params.get('response_type') !== 'code')
		return fail(
			OAuthErrorCode.UnsupportedResponseType,
			'Only the code response type is supported.'
		);
	const codeChallenge = params.get('code_challenge') ?? '';
	if (!PKCE_VALUE.test(codeChallenge))
		return fail(OAuthErrorCode.InvalidRequest, 'A PKCE code_challenge is required.');
	if (params.get('code_challenge_method') !== 'S256')
		return fail(OAuthErrorCode.InvalidRequest, 'Use the S256 code challenge method.');
	if (!resourceAllowed(params))
		return fail(OAuthErrorCode.InvalidTarget, `Tokens are only issued for ${mcpResource()}.`);
	return {
		kind: 'ok',
		request: { clientId: client.id, clientName: client.name, redirectUri, state, codeChallenge }
	};
}

export async function parseAuthorizationRequest(params: URLSearchParams) {
	const clientId = params.get('client_id');
	const [client] = clientId
		? await db().select().from(t.oauthClients).where(eq(t.oauthClients.id, clientId))
		: [];
	return checkAuthorizationRequest(params, client);
}

/** Records the consent as a single-use code and returns where to send the browser. */
export async function issueCode(
	request: AuthorizationRequest,
	session: { subject: string; name: string }
) {
	const code = newToken();
	await db().transaction(async (tx) => {
		await tx.insert(t.oauthCodes).values({
			id: hashToken(code),
			clientId: request.clientId,
			subject: session.subject,
			name: session.name,
			redirectUri: request.redirectUri,
			codeChallenge: request.codeChallenge,
			expiresAt: new Date(Date.now() + CODE_TTL)
		});
		await tx
			.update(t.oauthClients)
			.set({ authorizedAt: new Date() })
			.where(eq(t.oauthClients.id, request.clientId));
	});
	return redirectTo(request.redirectUri, { code, state: request.state, iss: origin() });
}
export function deniedLocation(request: AuthorizationRequest) {
	return redirectTo(request.redirectUri, {
		error: OAuthErrorCode.AccessDenied,
		error_description: 'The request was denied.',
		state: request.state,
		iss: origin()
	});
}

/** The client identity a token request presents: HTTP Basic or form fields (RFC 6749 §2.3.1). */
export function clientCredentials(form: URLSearchParams, authorization: string | null) {
	const basic = /^Basic\s+(\S+)$/i.exec(authorization ?? '');
	if (basic) {
		const decoded = Buffer.from(basic[1], 'base64').toString();
		const colon = decoded.indexOf(':');
		try {
			if (colon < 0) throw new URIError();
			const id = decodeURIComponent(decoded.slice(0, colon));
			const formId = form.get('client_id');
			if (formId && formId !== id) throw new URIError();
			return { id, secret: decodeURIComponent(decoded.slice(colon + 1)) };
		} catch {
			throw new OAuthError(OAuthErrorCode.InvalidClient, 'Malformed client credentials.');
		}
	}
	const id = form.get('client_id');
	if (!id) throw new OAuthError(OAuthErrorCode.InvalidClient, 'Client authentication is required.');
	return { id, secret: form.get('client_secret') ?? '' };
}

async function authenticateClient(form: URLSearchParams, authorization: string | null) {
	const credentials = clientCredentials(form, authorization);
	const [client] = await db()
		.select()
		.from(t.oauthClients)
		.where(eq(t.oauthClients.id, credentials.id));
	const secretMatches =
		client?.secretHash &&
		timingSafeEqual(Buffer.from(hashToken(credentials.secret)), Buffer.from(client.secretHash));
	if (!client || (client.authMethod !== 'none' && !secretMatches))
		throw new OAuthError(OAuthErrorCode.InvalidClient, 'Unknown client or wrong client secret.');
	return client;
}

function tokenResponse(access: string, refresh: string) {
	return {
		access_token: access,
		token_type: 'Bearer',
		expires_in: ACCESS_TTL / 1000,
		refresh_token: refresh,
		scope: MCP_SCOPE
	};
}

async function redeemCode(client: Client, form: URLSearchParams) {
	const code = form.get('code');
	const verifier = form.get('code_verifier');
	const redirectUri = form.get('redirect_uri');
	if (!code || !verifier || !redirectUri)
		throw new OAuthError(
			OAuthErrorCode.InvalidRequest,
			'code, code_verifier and redirect_uri are required.'
		);
	const [stored] = await db()
		.delete(t.oauthCodes)
		.where(
			and(
				eq(t.oauthCodes.id, hashToken(code)),
				eq(t.oauthCodes.clientId, client.id),
				gt(t.oauthCodes.expiresAt, new Date())
			)
		)
		.returning();
	if (!stored)
		throw new OAuthError(
			OAuthErrorCode.InvalidGrant,
			'The authorization code is invalid or expired.'
		);
	if (stored.redirectUri !== redirectUri)
		throw new OAuthError(
			OAuthErrorCode.InvalidGrant,
			'redirect_uri does not match the authorization request.'
		);
	if (!pkceMatches(verifier, stored.codeChallenge))
		throw new OAuthError(OAuthErrorCode.InvalidGrant, 'The code verifier does not match.');
	const access = newToken();
	const refresh = newToken();
	await db().transaction(async (tx) => {
		const [grant] = await tx
			.insert(t.oauthGrants)
			.values({
				clientId: client.id,
				subject: stored.subject,
				name: stored.name,
				refreshHash: hashToken(refresh),
				refreshExpiresAt: new Date(Date.now() + REFRESH_TTL)
			})
			.returning({ id: t.oauthGrants.id });
		await tx.insert(t.oauthTokens).values({
			id: hashToken(access),
			grantId: grant.id,
			expiresAt: new Date(Date.now() + ACCESS_TTL)
		});
	});
	return tokenResponse(access, refresh);
}

/** Rotates the refresh token: the presented one stops working at once. */
async function refreshGrant(client: Client, form: URLSearchParams) {
	const token = form.get('refresh_token');
	if (!token) throw new OAuthError(OAuthErrorCode.InvalidRequest, 'refresh_token is required.');
	const access = newToken();
	const refresh = newToken();
	const rotated = await db().transaction(async (tx) => {
		const [grant] = await tx
			.update(t.oauthGrants)
			.set({
				refreshHash: hashToken(refresh),
				refreshExpiresAt: new Date(Date.now() + REFRESH_TTL),
				lastUsedAt: new Date()
			})
			.where(
				and(
					eq(t.oauthGrants.refreshHash, hashToken(token)),
					eq(t.oauthGrants.clientId, client.id),
					gt(t.oauthGrants.refreshExpiresAt, new Date())
				)
			)
			.returning({ id: t.oauthGrants.id });
		if (!grant) return false;
		await tx.insert(t.oauthTokens).values({
			id: hashToken(access),
			grantId: grant.id,
			expiresAt: new Date(Date.now() + ACCESS_TTL)
		});
		return true;
	});
	if (!rotated)
		throw new OAuthError(
			OAuthErrorCode.InvalidGrant,
			'The refresh token is invalid or expired. Connect the application again.'
		);
	return tokenResponse(access, refresh);
}

/** The token endpoint (RFC 6749 §3.2). */
export async function exchangeToken(form: URLSearchParams, authorization: string | null) {
	const client = await authenticateClient(form, authorization);
	const now = new Date();
	await db().delete(t.oauthCodes).where(lt(t.oauthCodes.expiresAt, now));
	await db().delete(t.oauthTokens).where(lt(t.oauthTokens.expiresAt, now));
	await db().delete(t.oauthGrants).where(lt(t.oauthGrants.refreshExpiresAt, now));
	if (!resourceAllowed(form))
		throw new OAuthError(
			OAuthErrorCode.InvalidTarget,
			`Tokens are only issued for ${mcpResource()}.`
		);
	const grantType = form.get('grant_type');
	if (grantType === 'authorization_code') return redeemCode(client, form);
	if (grantType === 'refresh_token') return refreshGrant(client, form);
	throw new OAuthError(
		OAuthErrorCode.UnsupportedGrantType,
		'Use the authorization_code or refresh_token grant.'
	);
}

/** Resolves a bearer token for the MCP endpoint; revoked or expired tokens are refused. */
export async function verifyAccessToken(token: string): Promise<AuthInfo> {
	const [row] = await db()
		.select({
			grantId: t.oauthGrants.id,
			lastUsedAt: t.oauthGrants.lastUsedAt,
			clientId: t.oauthClients.id,
			clientName: t.oauthClients.name,
			expiresAt: t.oauthTokens.expiresAt
		})
		.from(t.oauthTokens)
		.innerJoin(t.oauthGrants, eq(t.oauthGrants.id, t.oauthTokens.grantId))
		.innerJoin(t.oauthClients, eq(t.oauthClients.id, t.oauthGrants.clientId))
		.where(and(eq(t.oauthTokens.id, hashToken(token)), gt(t.oauthTokens.expiresAt, new Date())))
		.limit(1);
	if (!row)
		throw new OAuthError(OAuthErrorCode.InvalidToken, 'The access token is invalid or expired.');
	if (Date.now() - row.lastUsedAt.getTime() > 60_000)
		await db()
			.update(t.oauthGrants)
			.set({ lastUsedAt: new Date() })
			.where(eq(t.oauthGrants.id, row.grantId));
	return {
		token,
		clientId: row.clientId,
		scopes: [MCP_SCOPE],
		expiresAt: Math.floor(row.expiresAt.getTime() / 1000),
		resource: new URL(mcpResource()),
		extra: { clientName: row.clientName }
	};
}

export async function listConnections(): Promise<Connection[]> {
	const rows = await db()
		.select({
			id: t.oauthGrants.id,
			clientName: t.oauthClients.name,
			userName: t.oauthGrants.name,
			createdAt: t.oauthGrants.createdAt,
			lastUsedAt: t.oauthGrants.lastUsedAt
		})
		.from(t.oauthGrants)
		.innerJoin(t.oauthClients, eq(t.oauthClients.id, t.oauthGrants.clientId))
		.where(gt(t.oauthGrants.refreshExpiresAt, new Date()))
		.orderBy(desc(t.oauthGrants.createdAt));
	return rows.map((row) => ({
		...row,
		createdAt: row.createdAt.toISOString(),
		lastUsedAt: row.lastUsedAt.toISOString()
	}));
}

/** Ends a connection at once: its access and refresh tokens go with it. */
export async function revokeConnection(id: string | undefined) {
	const [deleted] = await db()
		.delete(t.oauthGrants)
		.where(eq(t.oauthGrants.id, idSchema.parse(id)))
		.returning({ id: t.oauthGrants.id });
	if (!deleted) throw new ClientError(404, 'Connection not found.');
}
