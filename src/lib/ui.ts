export async function api<T>(
	path: string,
	body?: unknown,
	method?: string,
	interaction?: boolean
): Promise<T> {
	const requestMethod = method ?? (body === undefined ? 'GET' : 'POST');
	const response = await fetch(path, {
		method: requestMethod,
		headers: {
			...(body === undefined ? {} : { 'content-type': 'application/json' }),
			...((interaction ?? ['POST', 'PUT', 'PATCH', 'DELETE'].includes(requestMethod))
				? { 'x-studyloom-interaction': '1' }
				: {})
		},
		body: body === undefined ? undefined : JSON.stringify(body)
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
	URL.revokeObjectURL(url);
}
export function dateLabel(value: string | Date): string {
	return new Date(value).toLocaleDateString(undefined, {
		month: 'short',
		day: 'numeric',
		year: 'numeric'
	});
}
