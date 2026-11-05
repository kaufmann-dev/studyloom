import { lookup as dnsLookup } from 'node:dns';
import { request as httpRequest, type IncomingMessage } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { BlockList, isIP, type LookupFunction } from 'node:net';
import { PassThrough } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createBrotliDecompress, createGunzip, createInflate } from 'node:zlib';
import { MIME_TYPE } from '../domain';
import { ClientError, maxUploadBytes } from './config';

const MAX_BYTES = 50 * 1024 * 1024;
const MAX_REDIRECTS = 5;
const TIMEOUT_MS = 25_000;
const HEAD_BYTES = 128 * 1024;
const MAX_NAME_LENGTH = 160;
const HTML_TYPES = ['text/html', 'application/xhtml+xml'];
const DECODERS = {
	gzip: createGunzip,
	'x-gzip': createGunzip,
	deflate: createInflate,
	br: createBrotliDecompress
} as const;

export interface WebPage {
	/** The address that answered, after redirects and without a fragment. */
	url: string;
	/** The page title, or the file name for non-HTML downloads. */
	name: string;
	filename: string;
	mimeType: string;
	body: Buffer;
}

/** Raised for addresses that are not on the public internet; the message is for the server log. */
class NotPublicError extends Error {}

// IPv4 ranges that never hold a public website. IPv6 is the reverse: only global unicast
// (2000::/3) is reachable, minus documentation, 6to4 and Teredo, which also rules out
// loopback, unique-local, link-local and IPv4-mapped addresses.
const reserved = new BlockList();
for (const [network, prefix] of [
	['0.0.0.0', 8],
	['10.0.0.0', 8],
	['100.64.0.0', 10],
	['127.0.0.0', 8],
	['169.254.0.0', 16],
	['172.16.0.0', 12],
	['192.0.0.0', 24],
	['192.0.2.0', 24],
	['192.88.99.0', 24],
	['192.168.0.0', 16],
	['198.18.0.0', 15],
	['198.51.100.0', 24],
	['203.0.113.0', 24],
	['224.0.0.0', 4],
	['240.0.0.0', 4]
] as const)
	reserved.addSubnet(network, prefix, 'ipv4');
for (const [network, prefix] of [
	['2001::', 32],
	['2001:db8::', 32],
	['2002::', 16]
] as const)
	reserved.addSubnet(network, prefix, 'ipv6');
const globalUnicast = new BlockList();
globalUnicast.addSubnet('2000::', 3, 'ipv6');

export function isPublicAddress(address: string) {
	const family = isIP(address);
	if (family === 4) return !reserved.check(address, 'ipv4');
	if (family === 6) return globalUnicast.check(address, 'ipv6') && !reserved.check(address, 'ipv6');
	return false;
}

/**
 * Resolves names like `dns.lookup` but refuses every answer that is not a public address.
 * The connection uses exactly the addresses checked here, so a name that changes between a
 * check and the request (DNS rebinding) cannot reach the private network.
 */
const publicLookup: LookupFunction = (hostname, options, callback) => {
	dnsLookup(hostname, { ...options, all: true }, (cause, addresses) => {
		if (cause) return callback(cause, []);
		if (!addresses.length || !addresses.every(({ address }) => isPublicAddress(address)))
			return callback(new NotPublicError(`${hostname} is not a public address.`), []);
		if (options.all) return callback(null, addresses);
		callback(null, addresses[0].address, addresses[0].family);
	});
};

function parseUrl(value: string) {
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		throw new ClientError(400, 'Enter a valid web address.');
	}
	if (url.protocol !== 'http:' && url.protocol !== 'https:')
		throw new ClientError(400, 'Only http and https web addresses can be added.');
	if (url.username || url.password)
		throw new ClientError(400, 'Web addresses with a user name or password cannot be added.');
	url.hash = '';
	return url;
}

function requestPage(url: URL, lookup: LookupFunction, signal: AbortSignal) {
	// Addresses written as numbers skip name resolution, so they are checked here instead.
	const host = url.hostname.replace(/^\[|\]$/g, '');
	if (isIP(host) && !isPublicAddress(host))
		return Promise.reject(new NotPublicError(`${host} is not a public address.`));
	return new Promise<IncomingMessage>((resolve, reject) => {
		const send = url.protocol === 'https:' ? httpsRequest : httpRequest;
		send(
			url,
			{
				lookup,
				signal,
				agent: false,
				headers: {
					'user-agent': 'Mozilla/5.0 (compatible; Studyloom/1.0)',
					accept: 'text/html,application/xhtml+xml,application/pdf;q=0.9,*/*;q=0.8',
					'accept-encoding': Object.keys(DECODERS).join(', ')
				}
			},
			resolve
		)
			.once('error', reject)
			.end();
	});
}

async function readBody(response: IncomingMessage, limit: number) {
	if (Number(response.headers['content-length'] ?? 0) > limit) throw tooLarge(limit);
	const encoding = String(response.headers['content-encoding'] ?? 'identity').toLowerCase();
	const decoder =
		encoding === 'identity'
			? new PassThrough()
			: Object.hasOwn(DECODERS, encoding)
				? DECODERS[encoding as keyof typeof DECODERS]()
				: undefined;
	if (!decoder) throw new ClientError(400, 'The page uses an unsupported content encoding.');
	const parts: Buffer[] = [];
	let size = 0;
	await pipeline(response, decoder, async (source: AsyncIterable<Buffer>) => {
		for await (const part of source) {
			size += part.length;
			if (size > limit) throw tooLarge(limit);
			parts.push(part);
		}
	});
	return Buffer.concat(parts);
}
const tooLarge = (limit: number) =>
	new ClientError(413, `The page is larger than ${Math.round(limit / 1024 / 1024)} MB.`);

const NAMED_ENTITIES: Record<string, string> = {
	amp: '&',
	lt: '<',
	gt: '>',
	quot: '"',
	apos: "'",
	nbsp: ' ',
	ndash: '–',
	mdash: '—',
	hellip: '…',
	auml: 'ä',
	ouml: 'ö',
	uuml: 'ü',
	Auml: 'Ä',
	Ouml: 'Ö',
	Uuml: 'Ü',
	szlig: 'ß'
};
function decodeEntities(text: string) {
	return text.replace(/&(?:#(\d+)|#x([\da-f]+)|(\w+));/gi, (entity, decimal, hex, name) => {
		if (name) return NAMED_ENTITIES[name] ?? entity;
		const code = decimal ? Number(decimal) : parseInt(hex, 16);
		return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : entity;
	});
}
/** The `<title>` of an HTML document, read from its first bytes in the page's own encoding. */
function htmlTitle(body: Buffer, contentType: string) {
	const head = body.subarray(0, HEAD_BYTES);
	const label =
		/charset=["']?([\w-]+)/i.exec(contentType)?.[1] ??
		/<meta[^>]+charset=["']?([\w-]+)/i.exec(head.toString('latin1'))?.[1];
	let text: string;
	try {
		text = new TextDecoder(label).decode(head);
	} catch {
		text = new TextDecoder().decode(head);
	}
	const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(text)?.[1] ?? '';
	return decodeEntities(title).replace(/\s+/g, ' ').trim().slice(0, MAX_NAME_LENGTH);
}

function describe(url: URL, contentType: string, body: Buffer): WebPage {
	const mime = contentType.split(';')[0].trim().toLowerCase();
	const mimeType = MIME_TYPE.test(mime) ? mime : 'application/octet-stream';
	if (HTML_TYPES.includes(mimeType)) {
		const name = htmlTitle(body, contentType) || url.hostname;
		const safe = name.replace(/[\\/:*?"<>|\p{Cc}\s]+/gu, ' ').trim();
		return { url: url.href, name, filename: `${safe || url.hostname}.html`, mimeType, body };
	}
	let filename = url.hostname;
	try {
		filename = decodeURIComponent(url.pathname.split('/').filter(Boolean).at(-1) ?? '') || filename;
	} catch {
		// A malformed escape in the path leaves the host name as the file name.
	}
	filename = filename.slice(-MAX_NAME_LENGTH);
	return { url: url.href, name: filename, filename, mimeType, body };
}

function failure(cause: unknown, signal: AbortSignal) {
	if (cause instanceof ClientError) return cause;
	if (cause instanceof NotPublicError)
		return new ClientError(400, 'Only pages on the public internet can be added.');
	if (signal.aborted) return new ClientError(400, 'The website took too long to answer.');
	const code =
		cause && typeof cause === 'object' && 'code' in cause && typeof cause.code === 'string'
			? cause.code
			: '';
	if (code === 'ENOTFOUND' || code === 'EAI_AGAIN')
		return new ClientError(400, 'That web address could not be found.');
	return new ClientError(400, `The page could not be downloaded${code ? ` (${code})` : ''}.`);
}
function statusError(status: number) {
	if (status === 401 || status === 403)
		return new ClientError(
			400,
			'The website refused access. Pages that need a sign-in or block automated visitors cannot be added.'
		);
	if (status === 404 || status === 410)
		return new ClientError(400, `The page was not found (HTTP ${status}).`);
	return new ClientError(400, `The website answered with HTTP ${status}.`);
}

/**
 * Downloads a web page or file from the public internet. Redirects are followed, but every
 * address must be public, so the server cannot be used to reach its own network. `lookup` is
 * replaceable for tests only.
 */
export async function fetchWebPage(
	rawUrl: string,
	lookup: LookupFunction = publicLookup
): Promise<WebPage> {
	const signal = AbortSignal.timeout(TIMEOUT_MS);
	try {
		let url = parseUrl(rawUrl);
		for (let redirects = 0; ; redirects++) {
			const response = await requestPage(url, lookup, signal);
			const status = response.statusCode ?? 0;
			const location = response.headers.location;
			if (status >= 300 && status < 400 && location) {
				response.destroy();
				if (redirects === MAX_REDIRECTS)
					throw new ClientError(400, 'The page redirects too many times.');
				url = parseUrl(new URL(location, url).href);
				continue;
			}
			if (status < 200 || status >= 300) {
				response.destroy();
				throw statusError(status);
			}
			const body = await readBody(response, Math.min(MAX_BYTES, maxUploadBytes()));
			if (!body.length) throw new ClientError(400, 'The page is empty.');
			return describe(url, response.headers['content-type'] ?? '', body);
		}
	} catch (cause) {
		throw failure(cause, signal);
	}
}
