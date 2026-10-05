import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
	checkAuthorizationRequest,
	clientCredentials,
	pkceMatches,
	redirectMatches,
	validRedirectUri
} from './oauth';

const challenge = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM';
const client = {
	id: 'client-1',
	name: 'Claude',
	redirectUris: ['https://claude.ai/api/mcp/auth_callback', 'http://127.0.0.1:33418/callback']
};
const request = (overrides: Record<string, string | null> = {}) => {
	const params = new URLSearchParams({
		client_id: client.id,
		redirect_uri: client.redirectUris[0],
		response_type: 'code',
		code_challenge: challenge,
		code_challenge_method: 'S256',
		state: 'xyz',
		resource: 'https://studyloom.test/mcp'
	});
	for (const [key, value] of Object.entries(overrides))
		if (value === null) params.delete(key);
		else params.set(key, value);
	return params;
};

beforeEach(() => {
	vi.stubEnv('ORIGIN', 'https://studyloom.test');
});

describe('OAuth redirect URIs', () => {
	it('accepts https, loopback http and reverse-domain app schemes only', () => {
		expect(validRedirectUri('https://claude.ai/api/mcp/auth_callback')).toBe(true);
		expect(validRedirectUri('http://localhost:8080/callback')).toBe(true);
		expect(validRedirectUri('http://127.0.0.1/callback')).toBe(true);
		expect(validRedirectUri('http://[::1]:3000/cb')).toBe(true);
		expect(validRedirectUri('com.example.app:/oauth')).toBe(true);
		expect(validRedirectUri('http://example.com/callback')).toBe(false);
		expect(validRedirectUri('https://example.com/cb#fragment')).toBe(false);
		expect(validRedirectUri('https://user:pass@example.com/cb')).toBe(false);
		expect(validRedirectUri('javascript:alert(1)')).toBe(false);
		expect(validRedirectUri('not a url')).toBe(false);
	});

	it('lets loopback redirects change only their port', () => {
		const registered = 'http://127.0.0.1:33418/callback';
		expect(redirectMatches(registered, 'http://127.0.0.1:50123/callback')).toBe(true);
		expect(redirectMatches(registered, 'http://127.0.0.1:50123/other')).toBe(false);
		expect(redirectMatches(registered, 'http://localhost:33418/callback')).toBe(false);
		const https = 'https://claude.ai/api/mcp/auth_callback';
		expect(redirectMatches(https, https)).toBe(true);
		expect(redirectMatches(https, 'https://claude.ai:8443/api/mcp/auth_callback')).toBe(false);
	});
});

describe('OAuth authorization requests', () => {
	it('verifies S256 PKCE with the RFC 7636 example', () => {
		expect(pkceMatches('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk', challenge)).toBe(true);
		expect(pkceMatches('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXK', challenge)).toBe(false);
		expect(pkceMatches('short', challenge)).toBe(false);
	});

	it('accepts a complete request', () => {
		expect(checkAuthorizationRequest(request(), client)).toEqual({
			kind: 'ok',
			request: {
				clientId: client.id,
				clientName: 'Claude',
				redirectUri: client.redirectUris[0],
				state: 'xyz',
				codeChallenge: challenge
			}
		});
	});

	it('never redirects for an unknown client or an unregistered redirect URI', () => {
		expect(checkAuthorizationRequest(request(), undefined).kind).toBe('fatal');
		expect(
			checkAuthorizationRequest(request({ redirect_uri: 'https://evil.example/cb' }), client).kind
		).toBe('fatal');
		expect(checkAuthorizationRequest(request({ redirect_uri: null }), client).kind).toBe('fatal');
	});

	it('reports other problems to the client with state and issuer', () => {
		const redirected = (overrides: Record<string, string | null>) => {
			const result = checkAuthorizationRequest(request(overrides), client);
			if (result.kind !== 'redirect') throw new Error(`Expected a redirect, got ${result.kind}`);
			return new URL(result.location).searchParams;
		};
		const plain = redirected({ code_challenge_method: 'plain' });
		expect(plain.get('error')).toBe('invalid_request');
		expect(plain.get('state')).toBe('xyz');
		expect(plain.get('iss')).toBe('https://studyloom.test');
		expect(redirected({ code_challenge: null }).get('error')).toBe('invalid_request');
		expect(redirected({ response_type: 'token' }).get('error')).toBe('unsupported_response_type');
		expect(redirected({ resource: 'https://other.example/mcp' }).get('error')).toBe(
			'invalid_target'
		);
	});

	it('accepts a request without a resource and a loopback redirect on another port', () => {
		const result = checkAuthorizationRequest(
			request({ resource: null, redirect_uri: 'http://127.0.0.1:61000/callback' }),
			client
		);
		expect(result.kind).toBe('ok');
	});
});

describe('OAuth client authentication', () => {
	it('reads HTTP Basic credentials with URL-encoded parts', () => {
		const header = 'Basic ' + Buffer.from('client%3A1:s%20ecret').toString('base64');
		expect(clientCredentials(new URLSearchParams(), header)).toEqual({
			id: 'client:1',
			secret: 's ecret'
		});
	});

	it('reads form credentials and rejects missing or conflicting ones', () => {
		expect(
			clientCredentials(new URLSearchParams({ client_id: 'a', client_secret: 'b' }), null)
		).toEqual({ id: 'a', secret: 'b' });
		expect(clientCredentials(new URLSearchParams({ client_id: 'a' }), null)).toEqual({
			id: 'a',
			secret: ''
		});
		expect(() => clientCredentials(new URLSearchParams(), null)).toThrow('authentication');
		const header = 'Basic ' + Buffer.from('a:b').toString('base64');
		expect(() => clientCredentials(new URLSearchParams({ client_id: 'other' }), header)).toThrow(
			'Malformed'
		);
	});
});
