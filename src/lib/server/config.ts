import { resolve } from 'node:path';
export class ClientError extends Error {
	constructor(
		readonly status: 400 | 404 | 409 | 413 | 503,
		message: string
	) {
		super(message);
	}
}
export function required(name: string): string {
	const value = process.env[name];
	if (!value) throw new Error(`Missing required environment variable: ${name}`);
	return value;
}
export function origin(): string {
	return new URL(required('ORIGIN')).origin;
}
export function dataDir(): string {
	return resolve(process.env.DATA_DIR || '.data');
}
export function maxUploadBytes(): number {
	const value = Number(process.env.MAX_UPLOAD_BYTES || 2147483648);
	if (!Number.isSafeInteger(value) || value < 1)
		throw new Error('MAX_UPLOAD_BYTES must be a positive integer.');
	return value;
}
export function safeError(error: unknown): string {
	if (error && typeof error === 'object' && 'path' in error) {
		const code = 'code' in error && typeof error.code === 'string' ? error.code : undefined;
		return code ? `File operation failed (${code}).` : 'File operation failed.';
	}
	let message = error instanceof Error ? error.message : 'The operation failed.';
	for (const name of [
		'CLAUDE_CODE_OAUTH_TOKEN',
		'ELEVENLABS_API_KEY',
		'OIDC_CLIENT_SECRET',
		'DATABASE_URL'
	]) {
		const value = process.env[name];
		if (value) message = message.replaceAll(value, '[redacted]');
	}
	return message
		.replace(/Bearer\s+\S+/gi, 'Bearer [redacted]')
		.replace(/sk-ant-[A-Za-z0-9_-]+/g, '[redacted]')
		.slice(0, 2000);
}
