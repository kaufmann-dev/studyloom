import { describe, expect, it, vi } from 'vitest';
import { inArray } from 'drizzle-orm';
import { db, closeDatabase } from './db';
import { oauthClients } from './db/schema';
import {
	exchangeToken,
	issueCode,
	listConnections,
	parseAuthorizationRequest,
	registerClient,
	revokeConnection,
	verifyAccessToken
} from './oauth';
import { useTestDatabase } from './testing';

const verifier = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
const challenge = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM';

describe.skipIf(!process.env.TEST_DATABASE_URL)('OAuth for MCP clients', () => {
	it('issues single-use codes, rotates refresh tokens and revokes connections', async () => {
		const environment = await useTestDatabase('oauth');
		vi.stubEnv('ORIGIN', 'https://studyloom.test');
		const clientIds: string[] = [];
		const authorize = async (clientId: string, redirectUri: string) => {
			const result = await parseAuthorizationRequest(
				new URLSearchParams({
					client_id: clientId,
					redirect_uri: redirectUri,
					response_type: 'code',
					code_challenge: challenge,
					code_challenge_method: 'S256',
					state: 'state-1'
				})
			);
			if (result.kind !== 'ok') throw new Error(`Authorization failed: ${result.kind}`);
			const location = new URL(
				await issueCode(result.request, { subject: 'subject-1', name: 'Tester' })
			);
			expect(location.searchParams.get('state')).toBe('state-1');
			return location.searchParams.get('code')!;
		};
		const exchange = (fields: Record<string, string>, authorization: string | null = null) =>
			exchangeToken(new URLSearchParams(fields), authorization);
		try {
			await expect(
				registerClient({ redirect_uris: ['http://example.com/callback'] })
			).rejects.toMatchObject({ code: 'invalid_redirect_uri' });

			const cli = await registerClient({
				redirect_uris: ['http://127.0.0.1:4000/callback'],
				client_name: 'Test CLI',
				token_endpoint_auth_method: 'none'
			});
			clientIds.push(cli.client_id);
			expect(cli).not.toHaveProperty('client_secret');
			const redirectUri = 'http://127.0.0.1:5000/callback';
			const redeem = {
				grant_type: 'authorization_code',
				client_id: cli.client_id,
				code: await authorize(cli.client_id, redirectUri),
				code_verifier: verifier,
				redirect_uri: redirectUri
			};
			const tokens = await exchange(redeem);
			expect(tokens).toMatchObject({ token_type: 'Bearer', expires_in: 3600, scope: 'studyloom' });
			await expect(exchange(redeem)).rejects.toMatchObject({ code: 'invalid_grant' });
			expect(await verifyAccessToken(tokens.access_token)).toMatchObject({
				clientId: cli.client_id,
				scopes: ['studyloom'],
				extra: { clientName: 'Test CLI' }
			});

			const refresh = {
				grant_type: 'refresh_token',
				client_id: cli.client_id,
				refresh_token: tokens.refresh_token
			};
			const refreshed = await exchange(refresh);
			await expect(exchange(refresh)).rejects.toMatchObject({ code: 'invalid_grant' });
			await verifyAccessToken(refreshed.access_token);

			// A wrong verifier burns the code.
			const guessed = {
				...redeem,
				code: await authorize(cli.client_id, redirectUri),
				code_verifier: 'x'.repeat(43)
			};
			await expect(exchange(guessed)).rejects.toMatchObject({ code: 'invalid_grant' });
			await expect(exchange({ ...guessed, code_verifier: verifier })).rejects.toMatchObject({
				code: 'invalid_grant'
			});

			const web = await registerClient({
				redirect_uris: ['https://app.example/callback'],
				client_name: 'Web app'
			});
			clientIds.push(web.client_id);
			expect(web.token_endpoint_auth_method).toBe('client_secret_basic');
			const basic = (secret: string) =>
				'Basic ' + Buffer.from(`${web.client_id}:${secret}`).toString('base64');
			const webRedeem = {
				grant_type: 'authorization_code',
				code: await authorize(web.client_id, 'https://app.example/callback'),
				code_verifier: verifier,
				redirect_uri: 'https://app.example/callback'
			};
			await expect(exchange(webRedeem, basic('wrong'))).rejects.toMatchObject({
				code: 'invalid_client'
			});
			await exchange(webRedeem, basic(web.client_secret!));

			const connection = (await listConnections()).find((c) => c.clientName === 'Test CLI');
			expect(connection).toMatchObject({ userName: 'Tester' });
			await revokeConnection(connection!.id);
			await expect(verifyAccessToken(refreshed.access_token)).rejects.toMatchObject({
				code: 'invalid_token'
			});
			await expect(
				exchange({ ...refresh, refresh_token: refreshed.refresh_token })
			).rejects.toMatchObject({ code: 'invalid_grant' });
		} finally {
			if (clientIds.length)
				await db().delete(oauthClients).where(inArray(oauthClients.id, clientIds));
			await closeDatabase();
			await environment.restore();
			vi.unstubAllEnvs();
		}
	});
});
