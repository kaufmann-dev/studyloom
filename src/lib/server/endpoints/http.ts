import { error, json, type RequestEvent } from '@sveltejs/kit';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { MIME_TYPE } from '../../domain';
import { ClientError } from '../config';

/** One parsed `/api/<resource>/<id>/<action>/<seq>` request. */
export interface Route {
	event: RequestEvent;
	method: string;
	id?: string;
	action?: string;
	seq?: string;
}
/** Returns nothing when the resource has no matching endpoint. */
export type Handler = (route: Route) => Promise<Response | undefined>;

const JSON_BODY_LIMIT = 1024 * 1024;
const INLINE_TYPES =
	/^(audio\/(wav|mpeg|ogg|webm|mp4|x-m4a|flac)|video\/(mp4|webm)|image\/(png|jpeg|webp)|application\/pdf|text\/plain)$/;

export const ok = () => json({ ok: true });
export const created = (data: unknown) => json(data, { status: 201 });
export const accepted = (data: unknown) => json(data, { status: 202 });

export async function boundedBody(request: Request, limit: number) {
	if (!request.body) return Buffer.alloc(0);
	const reader = request.body.getReader();
	const parts: Buffer[] = [];
	let size = 0;
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			size += value.length;
			if (size > limit) {
				await reader.cancel();
				error(413, 'Request too large.');
			}
			parts.push(Buffer.from(value));
		}
	} finally {
		reader.releaseLock();
	}
	return Buffer.concat(parts);
}

export async function readJson(event: RequestEvent): Promise<unknown> {
	const length = Number(event.request.headers.get('content-length') || 0);
	if (length > JSON_BODY_LIMIT) error(413, 'Request too large.');
	try {
		return JSON.parse((await boundedBody(event.request, JSON_BODY_LIMIT)).toString());
	} catch (cause) {
		if (cause instanceof SyntaxError) throw new ClientError(400, 'Invalid JSON request.');
		throw cause;
	}
}

/** Streams a stored file with range support; unknown types are forced to download. */
export async function download(event: RequestEvent, path: string, mime: string, name: string) {
	const info = await stat(path).catch(() => null);
	if (!info?.isFile()) error(404, 'File is not ready yet.');
	const contentType = MIME_TYPE.test(mime) ? mime : 'application/octet-stream';
	const inline = INLINE_TYPES.test(contentType) && !event.url.searchParams.has('download');
	const headers: Record<string, string> = {
		'content-type': inline ? contentType : 'application/octet-stream',
		'content-disposition': `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(name)}`,
		'accept-ranges': 'bytes',
		'x-content-type-options': 'nosniff',
		'content-security-policy': "sandbox; default-src 'none'",
		'cache-control': 'private, no-store'
	};
	const unsatisfiable = () =>
		new Response(null, { status: 416, headers: { 'content-range': `bytes */${info.size}` } });
	const range = event.request.headers.get('range');
	let start = 0;
	let end = info.size - 1;
	let status = 200;
	if (range) {
		const match = /^bytes=(\d*)-(\d*)$/.exec(range);
		if (!match || (!match[1] && !match[2])) return unsatisfiable();
		if (!match[1]) start = Math.max(0, info.size - Number(match[2]));
		else {
			start = Number(match[1]);
			if (match[2]) end = Math.min(end, Number(match[2]));
		}
		if (start > end || start >= info.size) return unsatisfiable();
		status = 206;
		headers['content-range'] = `bytes ${start}-${end}/${info.size}`;
	}
	headers['content-length'] = String(Math.max(0, end - start + 1));
	return new Response(
		info.size ? (Readable.toWeb(createReadStream(path, { start, end })) as ReadableStream) : null,
		{ status, headers }
	);
}
