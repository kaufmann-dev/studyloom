import type { z } from 'zod';
import type { CalendarEvent, eventInput, eventPatchInput, exceptionInput } from './domain';
import { api } from './ui';

/** The events touching one date range; every change reloads that range. */
export class Events {
	items = $state.raw<CalendarEvent[]>([]);
	#query = '';
	#version = 0;

	async load(from: string, to: string, projectId?: string) {
		this.#query = `from=${from}&to=${to}${projectId ? `&projectId=${projectId}` : ''}`;
		await this.reload();
	}
	async reload() {
		if (!this.#query) return;
		const version = ++this.#version;
		const { events } = await api<{ events: CalendarEvent[] }>(`/api/events?${this.#query}`);
		// A slower earlier request must not replace the range that was asked for last.
		if (version === this.#version) this.items = events;
	}
	find(id: string) {
		return this.items.find((event) => event.id === id);
	}
	async create(input: z.input<typeof eventInput>) {
		await api('/api/events', { body: input });
		await this.reload();
	}
	async update(id: string, patch: z.input<typeof eventPatchInput>) {
		await api(`/api/events/${id}`, { method: 'PATCH', body: patch });
		await this.reload();
	}
	async remove(id: string) {
		await api(`/api/events/${id}`, { method: 'DELETE' });
		await this.reload();
	}
	/** Skips or changes one occurrence of a repeating event. */
	async setException(id: string, date: string, body: z.input<typeof exceptionInput>) {
		await api(`/api/events/${id}/exceptions/${date}`, { method: 'PUT', body });
		await this.reload();
	}
	async clearException(id: string, date: string) {
		await api(`/api/events/${id}/exceptions/${date}`, { method: 'DELETE' });
		await this.reload();
	}
}
