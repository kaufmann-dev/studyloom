import type { IncomingMessage } from 'node:http';
import { WebSocket } from 'ws';
import { readSession, SESSION_COOKIE } from '../lib/server/auth';

export function tokenFrom(req: IncomingMessage) {
	return req.headers.cookie
		?.split(';')
		.map((s) => s.trim())
		.find((s) => s.startsWith(SESSION_COOKIE + '='))
		?.slice(SESSION_COOKIE.length + 1);
}
export const send = (client: WebSocket, value: unknown) => {
	if (client.readyState === WebSocket.OPEN) client.send(JSON.stringify(value));
};
/** Re-checks the browser session every 30 s without extending it; returns the stop function. */
export function watchSession(
	client: WebSocket,
	token: string | undefined,
	expired: string,
	fail: (e: unknown) => void
) {
	const heartbeat = setInterval(() => {
		void readSession(token)
			.then((session) => {
				if (!session) fail(new Error(expired));
				else client.ping();
			})
			.catch(fail);
	}, 30000);
	return () => clearInterval(heartbeat);
}
