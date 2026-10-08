import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo, LookupFunction } from 'node:net';
import { gzipSync } from 'node:zlib';
import { fetchWebPage, isPublicAddress } from './web-page';

// Resolves every name to the local test server, standing in for DNS.
const toLocalServer: LookupFunction = (_hostname, options, callback) =>
	options.all
		? callback(null, [{ address: '127.0.0.1', family: 4 }])
		: callback(null, '127.0.0.1', 4);

describe('public address policy', () => {
	it.each([
		'93.184.216.34',
		'8.8.8.8',
		'172.32.0.1',
		'2606:2800:220:1:248:1893:25c8:1946',
		'2a00:1450:4001:81b::200e'
	])('allows %s', (address) => expect(isPublicAddress(address)).toBe(true));

	it.each([
		'127.0.0.1',
		'0.0.0.0',
		'10.1.2.3',
		'100.64.0.1',
		'169.254.169.254',
		'172.16.0.1',
		'192.168.1.1',
		'224.0.0.1',
		'255.255.255.255',
		'::',
		'::1',
		'fe80::1',
		'fd00::1',
		'::ffff:127.0.0.1',
		'::ffff:10.0.0.1',
		'64:ff9b::a00:1',
		'2001:db8::1',
		'not an address'
	])('refuses %s', (address) => expect(isPublicAddress(address)).toBe(false));
});

describe('refused addresses', () => {
	it.each([
		['ftp://example.com/file', 'http and https'],
		['file:///etc/passwd', 'http and https'],
		['https://user:secret@example.com/', 'user name or password'],
		['not a url', 'valid web address'],
		['http://127.0.0.1:9/', 'public internet'],
		['http://2130706433/', 'public internet'],
		['http://[::1]/', 'public internet'],
		['http://[::ffff:7f00:1]/', 'public internet'],
		['http://169.254.169.254/latest/meta-data/', 'public internet'],
		['http://10.0.0.5:5432/', 'public internet'],
		['http://localhost:9/', 'public internet']
	])('rejects %s', async (url, message) => {
		await expect(fetchWebPage(url)).rejects.toMatchObject({
			status: 400,
			message: expect.stringContaining(message)
		});
	});
});

describe('downloading a page', () => {
	let server: Server;
	let base: string;
	const hits: string[] = [];

	beforeAll(async () => {
		server = createServer((request, response) => {
			const path = request.url ?? '/';
			hits.push(path);
			const send = (status: number, type: string, body: Buffer | string, extra = {}) => {
				response.writeHead(status, { 'content-type': type, ...extra });
				response.end(body);
			};
			if (path === '/article')
				return send(
					200,
					'text/html;charset=utf-8',
					'<!doctype html><html><head><title>\n  Führung &amp; KI &#8211; &uuml;ber&#x41; &nbsp;Kompass | Academy </title></head><body><p>Text</p></body></html>'
				);
			if (path === '/latin1')
				return send(
					200,
					'text/html',
					Buffer.from(
						'<html><head><meta charset="iso-8859-1"><title>Größe</title></head></html>',
						'latin1'
					)
				);
			if (path === '/untitled') return send(200, 'text/html', '<html><body>Hi</body></html>');
			if (path === '/zipped')
				return send(200, 'text/html', gzipSync('<title>Zipped</title><p>packed</p>'), {
					'content-encoding': 'gzip'
				});
			if (path === '/paper.pdf') return send(200, 'application/pdf', '%PDF-1.7 fake');
			if (path === '/move') return send(302, 'text/plain', '', { location: '/final#section' });
			if (path === '/final') return send(200, 'text/html', '<title>Final</title>');
			if (path === '/loop') return send(302, 'text/plain', '', { location: '/loop' });
			if (path === '/to-private')
				return send(302, 'text/plain', '', { location: 'http://10.0.0.5/admin' });
			if (path === '/to-ftp')
				return send(302, 'text/plain', '', { location: 'ftp://example.com/' });
			if (path === '/members') return send(403, 'text/html', 'Members only');
			if (path === '/empty') return send(200, 'text/html', '');
			if (path === '/big') return send(200, 'text/html', 'x'.repeat(5000));
			if (path === '/bomb')
				return send(200, 'text/html', gzipSync('x'.repeat(50_000)), { 'content-encoding': 'gzip' });
			if (path === '/odd-encoding')
				return send(200, 'text/html', 'x', { 'content-encoding': 'zstd' });
			send(404, 'text/html', 'Not here');
		});
		await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
		base = `http://site.test:${(server.address() as AddressInfo).port}`;
	});
	afterAll(() => new Promise((resolve) => server.close(resolve)));

	const download = (path: string) => fetchWebPage(base + path, toLocalServer);

	it('names the source after the page title and keeps the HTML', async () => {
		const page = await download('/article');
		expect(page).toMatchObject({
			url: `${base}/article`,
			name: 'Führung & KI – überA Kompass | Academy',
			mimeType: 'text/html'
		});
		expect(page.body.toString()).toContain('<p>Text</p>');
	});

	it('names the file after the title without characters filesystems reject', async () => {
		const page = await download('/article');
		expect(page.filename).toBe('Führung & KI – überA Kompass Academy.html');
		expect(page.filename).not.toMatch(/[\\/:*?"<>|]/);
	});

	it('reads titles in the page encoding', async () => {
		expect((await download('/latin1')).name).toBe('Größe');
	});

	it('falls back to the host name without a title', async () => {
		expect(await download('/untitled')).toMatchObject({
			name: 'site.test',
			filename: 'site.test.html'
		});
	});

	it('decodes compressed responses', async () => {
		const page = await download('/zipped');
		expect(page.name).toBe('Zipped');
		expect(page.body.toString()).toContain('packed');
	});

	it('keeps other files as they are, named after the address', async () => {
		expect(await download('/paper.pdf')).toMatchObject({
			name: 'paper.pdf',
			filename: 'paper.pdf',
			mimeType: 'application/pdf'
		});
	});

	it('follows redirects and reports the final address without its fragment', async () => {
		expect(await download('/move')).toMatchObject({ url: `${base}/final`, name: 'Final' });
	});

	it('stops redirect loops', async () => {
		await expect(download('/loop')).rejects.toMatchObject({
			message: expect.stringContaining('redirects too many times')
		});
	});

	it('refuses redirects into the private network or to other schemes', async () => {
		await expect(download('/to-private')).rejects.toMatchObject({
			message: expect.stringContaining('public internet')
		});
		await expect(download('/to-ftp')).rejects.toMatchObject({
			message: expect.stringContaining('http and https')
		});
	});

	it('explains refused, missing and empty pages', async () => {
		await expect(download('/members')).rejects.toMatchObject({
			message: expect.stringContaining('refused access')
		});
		await expect(download('/missing')).rejects.toMatchObject({
			message: expect.stringContaining('not found (HTTP 404)')
		});
		await expect(download('/empty')).rejects.toMatchObject({
			message: expect.stringContaining('empty')
		});
		await expect(download('/odd-encoding')).rejects.toMatchObject({
			message: expect.stringContaining('content encoding')
		});
	});

	it('enforces the size limit on the decompressed bytes', async () => {
		vi.stubEnv('MAX_UPLOAD_BYTES', '2000');
		try {
			await expect(download('/big')).rejects.toMatchObject({ status: 413 });
			await expect(download('/bomb')).rejects.toMatchObject({ status: 413 });
			expect((await download('/article')).body.length).toBeGreaterThan(0);
		} finally {
			vi.unstubAllEnvs();
		}
	});
});
