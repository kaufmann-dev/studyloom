import { resolve } from 'node:path';
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
	let message = error instanceof Error ? error.message : 'The operation failed.';
	for (const name of ['TRANSCRIPTION_API_KEY', 'OIDC_CLIENT_SECRET', 'DATABASE_URL']) {
		const value = process.env[name];
		if (value) message = message.replaceAll(value, '[redacted]');
	}
	return message
		.replace(/Bearer\s+\S+/gi, 'Bearer [redacted]')
		.replace(/LLM_[A-Za-z0-9_-]+/g, '[redacted]')
		.slice(0, 2000);
}
