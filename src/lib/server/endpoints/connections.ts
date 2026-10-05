import { listConnections, revokeConnection } from '../oauth';
import { ok, type Handler } from './http';

/** MCP connections: list them, or disconnect one. */
export const connections: Handler = async ({ method, id, action }) => {
	if (action) return;
	if (!id && method === 'GET') return Response.json({ connections: await listConnections() });
	if (id && method === 'DELETE') {
		await revokeConnection(id);
		return ok();
	}
};
