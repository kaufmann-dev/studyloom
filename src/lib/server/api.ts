import { error, type RequestEvent } from '@sveltejs/kit';
import { z } from 'zod';
import { ClientError, safeError } from './config';
import { museHost, museStatus } from './muse';
import type { Handler } from './endpoints/http';
import { library } from './endpoints/library';
import { assets, materials, recordings } from './endpoints/materials';
import { pins } from './endpoints/pins';
import { projects } from './endpoints/projects';
import { conversations, jobs, outputs } from './endpoints/study';

async function museAction<T>(operation: Promise<T>): Promise<T> {
	try {
		return await operation;
	} catch (cause) {
		console.error('Muse request failed:', safeError(cause));
		throw new ClientError(503, 'Muse is unavailable. Check Settings and retry.');
	}
}
const museCalls: Record<string, [method: string, params?: Record<string, unknown>]> = {
	login: ['account/loginStart', { type: 'deviceCode' }],
	'cancel-login': ['account/loginCancel'],
	logout: ['account/logout']
};
const muse: Handler = async ({ method, id }) => {
	if (method === 'GET') return Response.json(await museAction(museStatus()));
	const call = method === 'POST' && id && Object.hasOwn(museCalls, id) ? museCalls[id] : undefined;
	if (call) return Response.json(await museAction(museHost.call(...call)));
};

const resources = new Map<string, Handler>(
	Object.entries({
		library,
		pins,
		muse,
		projects,
		materials,
		recordings,
		assets,
		conversations,
		outputs,
		jobs
	})
);

/** Dispatches every authenticated `/api/<resource>/<id>/<action>/<seq>` request. */
export async function api(event: RequestEvent) {
	const method = event.request.method;
	const [resource, id, action, seq] = event.url.pathname.slice(5).split('/').filter(Boolean);
	if (resource === 'health' && method === 'GET') return Response.json({ status: 'ok' });
	if (!event.locals.session) error(401, 'Please sign in.');
	try {
		const response = await resources.get(resource)?.({ event, method, id, action, seq });
		if (response) return response;
	} catch (cause) {
		if (cause instanceof z.ZodError)
			error(400, cause.issues.map((issue) => issue.message).join('; '));
		if (cause instanceof ClientError) error(cause.status, cause.message);
		throw cause;
	}
	error(404, 'Endpoint not found.');
}
