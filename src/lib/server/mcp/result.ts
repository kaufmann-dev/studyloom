import { isHttpError } from '@sveltejs/kit';
import type { CallToolResult } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { ClientError, safeError } from '../config';

export function json(value: unknown): CallToolResult {
	return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] };
}
function failure(message: string): CallToolResult {
	return { isError: true, content: [{ type: 'text', text: message }] };
}
/** Runs a tool, reporting client errors to the model and hiding unexpected ones. */
export async function guard(fn: () => Promise<unknown>): Promise<CallToolResult> {
	try {
		return json(await fn());
	} catch (cause) {
		if (cause instanceof z.ZodError) return failure(cause.issues.map((i) => i.message).join('; '));
		if (cause instanceof ClientError) return failure(cause.message);
		if (isHttpError(cause) && cause.status < 500) return failure(cause.body.message);
		console.error('MCP tool failed:', safeError(cause));
		return failure('Internal error. Try again later.');
	}
}
