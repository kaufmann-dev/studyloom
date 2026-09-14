import * as oidc from 'openid-client';
import { randomBytes, createHash } from 'node:crypto';
import { and, eq, gt } from 'drizzle-orm';
import type { Cookies } from '@sveltejs/kit';
import { db } from './db';
import { sessions, authFlows } from './db/schema';
import { origin, required } from './config';
const DAY = 86400_000;
export const SESSION_COOKIE = 'studyloom_session';
const FLOW_COOKIE = 'studyloom_oidc';
export const hashToken = (value: string) => createHash('sha256').update(value).digest('hex');
export function safeReturnTo(value: string | null | undefined): string {
	if (
		!value ||
		!value.startsWith('/') ||
		value.startsWith('//') ||
		[...value].some((c) => c.charCodeAt(0) <= 32 || c === '\\')
	)
		return '/';
	try {
		const u = new URL(value, 'https://studyloom.invalid');
		return u.origin === 'https://studyloom.invalid' &&
			!u.pathname.startsWith('/auth/') &&
			u.pathname !== '/login'
			? u.pathname + u.search + u.hash
			: '/';
	} catch {
		return '/';
	}
}
let configuration: Promise<oidc.Configuration> | undefined;
export function oidcConfig() {
	return (configuration ??= oidc
		.discovery(
			new URL(required('OIDC_ISSUER')),
			required('OIDC_CLIENT_ID'),
			undefined,
			oidc.ClientSecretPost(required('OIDC_CLIENT_SECRET'))
		)
		.catch((e) => {
			configuration = undefined;
			throw e;
		}));
}
function cookieOptions(maxAge: number) {
	return {
		path: '/',
		httpOnly: true,
		secure: origin().startsWith('https:'),
		sameSite: 'lax' as const,
		maxAge
	};
}
export function sessionAlive(row: { expiresAt: Date; lastActiveAt: Date }, now = Date.now()) {
	return row.expiresAt.getTime() > now && now - row.lastActiveAt.getTime() < DAY;
}
export async function readSession(token: string | undefined, active = false) {
	if (!token) return null;
	const [session] = await db()
		.select()
		.from(sessions)
		.where(eq(sessions.id, hashToken(token)))
		.limit(1);
	if (!session) return null;
	if (!sessionAlive(session)) {
		await db().delete(sessions).where(eq(sessions.id, session.id));
		return null;
	}
	if (active && Date.now() - session.lastActiveAt.getTime() > 60_000)
		await db()
			.update(sessions)
			.set({ lastActiveAt: new Date() })
			.where(eq(sessions.id, session.id));
	return { subject: session.subject, name: session.name };
}
export async function startLogin(cookies: Cookies, returnTo: string | null) {
	const config = await oidcConfig();
	const state = oidc.randomState();
	const verifier = oidc.randomPKCECodeVerifier();
	const nonce = oidc.randomNonce();
	await db()
		.insert(authFlows)
		.values({
			id: hashToken(state),
			verifier,
			nonce,
			returnTo: safeReturnTo(returnTo),
			expiresAt: new Date(Date.now() + 10 * 60_000)
		});
	cookies.set(FLOW_COOKIE, state, cookieOptions(600));
	return oidc.buildAuthorizationUrl(config, {
		redirect_uri: origin() + '/auth/callback',
		response_type: 'code',
		scope: 'openid profile',
		state,
		nonce,
		code_challenge: await oidc.calculatePKCECodeChallenge(verifier),
		code_challenge_method: 'S256'
	}).href;
}
export async function finishLogin(cookies: Cookies, url: URL) {
	const state = cookies.get(FLOW_COOKIE);
	cookies.delete(FLOW_COOKIE, { path: '/' });
	if (!state || state !== url.searchParams.get('state'))
		throw new Error('Invalid login state. Please sign in again.');
	const [flow] = await db()
		.delete(authFlows)
		.where(and(eq(authFlows.id, hashToken(state)), gt(authFlows.expiresAt, new Date())))
		.returning();
	if (!flow) throw new Error('This login has expired. Please sign in again.');
	const callback = new URL(url.pathname + url.search, origin());
	const tokens = await oidc.authorizationCodeGrant(await oidcConfig(), callback, {
		pkceCodeVerifier: flow.verifier,
		expectedState: state,
		expectedNonce: flow.nonce,
		idTokenExpected: true
	});
	const claims = tokens.claims();
	if (!claims?.sub || !tokens.id_token)
		throw new Error('The identity provider did not return an identity.');
	const previous = cookies.get(SESSION_COOKIE);
	if (previous)
		await db()
			.delete(sessions)
			.where(eq(sessions.id, hashToken(previous)));
	const token = randomBytes(32).toString('base64url');
	await db()
		.insert(sessions)
		.values({
			id: hashToken(token),
			subject: claims.sub,
			name: typeof claims.name === 'string' ? claims.name : 'Your workspace',
			idToken: tokens.id_token,
			expiresAt: new Date(Date.now() + 7 * DAY)
		});
	cookies.set(SESSION_COOKIE, token, cookieOptions(7 * 86400));
	return flow.returnTo;
}
export async function logout(cookies: Cookies) {
	const token = cookies.get(SESSION_COOKIE);
	cookies.delete(SESSION_COOKIE, { path: '/' });
	if (!token) return '/login';
	const [session] = await db()
		.delete(sessions)
		.where(eq(sessions.id, hashToken(token)))
		.returning();
	if (!session) return '/login';
	return oidc.buildEndSessionUrl(await oidcConfig(), {
		id_token_hint: session.idToken,
		post_logout_redirect_uri: origin() + '/auth/logout/callback'
	}).href;
}
