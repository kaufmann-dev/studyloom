import { toast } from 'svelte-sonner';

interface RequestOptions {
	method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
	/** Sent as JSON, or as raw bytes when given a Blob. */
	body?: unknown;
	/** Counts as user activity for the idle session timeout. Defaults to true for writes only. */
	interaction?: boolean;
	headers?: Record<string, string>;
	signal?: AbortSignal;
}

export async function api<T = void>(path: string, options: RequestOptions = {}): Promise<T> {
	const { body } = options;
	const method = options.method ?? (body === undefined ? 'GET' : 'POST');
	const headers: Record<string, string> = { ...options.headers };
	if (body instanceof Blob) headers['content-type'] = 'application/octet-stream';
	else if (body !== undefined) headers['content-type'] = 'application/json';
	if (options.interaction ?? method !== 'GET') headers['x-studyloom-interaction'] = '1';
	const response = await fetch(path, {
		method,
		headers,
		body: body === undefined || body instanceof Blob ? body : JSON.stringify(body),
		signal: options.signal
	});
	if (!response.ok) {
		const detail = await response.json().catch(() => null);
		throw new Error(detail?.message ?? detail?.error ?? `Request failed (${response.status}).`);
	}
	if (response.status === 204) return undefined as T;
	return response.json();
}
export function errorText(error: unknown): string {
	return error instanceof Error ? error.message : 'Something went wrong. Please try again.';
}
export function downloadText(filename: string, text: string): void {
	const url = URL.createObjectURL(new Blob([text], { type: 'text/markdown;charset=utf-8' }));
	const anchor = document.createElement('a');
	anchor.href = url;
	anchor.download = filename;
	anchor.click();
	setTimeout(() => URL.revokeObjectURL(url), 0);
}
export async function copyText(text: string, confirmation = 'Copied.'): Promise<void> {
	try {
		await navigator.clipboard.writeText(text);
		toast.success(confirmation);
	} catch (error) {
		toast.error(errorText(error));
	}
}
export function dateLabel(value: string | Date): string {
	return new Date(value).toLocaleDateString(undefined, {
		month: 'short',
		day: 'numeric',
		year: 'numeric'
	});
}
export function fileSize(bytes: number): string {
	if (bytes < 1024 * 1024) return `${Math.max(1, Math.ceil(bytes / 1024))} KB`;
	return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
/** `plural(2, 'source')` → "2 sources"; pass the plural form when it is irregular. */
export function plural(count: number, noun: string, many = `${noun}s`): string {
	return `${count} ${count === 1 ? noun : many}`;
}
/** "just now", "12 min ago", "3 h ago", or the date for anything older than a day. */
export function timeAgo(value: string | Date, now = new Date()): string {
	const minutes = Math.floor((now.getTime() - new Date(value).getTime()) / 60_000);
	if (minutes < 1) return 'just now';
	if (minutes < 60) return `${minutes} min ago`;
	const hours = Math.floor(minutes / 60);
	return hours < 24 ? `${hours} h ago` : dateLabel(value);
}
