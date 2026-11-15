import { error, type RequestEvent } from '@sveltejs/kit';
import { z } from 'zod';
import { ClientError } from './config';
import { claudeStatus } from './claude';
import { illustrationsAvailable } from './gemini';
import { calendar } from './endpoints/calendar';
import { events } from './endpoints/events';
import type { Handler } from './endpoints/http';
import { library } from './endpoints/library';
import { assets, materials, recordings } from './endpoints/materials';
import { pins } from './endpoints/pins';
import { projects } from './endpoints/projects';
import { speech } from './endpoints/speech';
import { conversations, jobs, outputs } from './endpoints/study';
import { tasks } from './endpoints/tasks';

const claude: Handler = async ({ method, id }) => {
	if (method === 'GET' && !id) return Response.json(await claudeStatus());
};

/** Whether lesson illustrations can be generated: the Gemini key is set. */
const illustrations: Handler = async ({ method, id }) => {
	if (method === 'GET' && !id) return Response.json({ available: illustrationsAvailable() });
};

const resources = new Map<string, Handler>(
	Object.entries({
		library,
		pins,
		tasks,
		events,
		calendar,
		claude,
		speech,
		illustrations,
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
