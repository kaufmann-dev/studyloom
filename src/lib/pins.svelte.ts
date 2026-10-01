import type { Pin } from './domain';
import { api } from './ui';

/** The pinned projects and Library items, shared by every page that can pin. */
export class Pins {
	items = $state.raw<Pin[]>([]);
	/** Target or pin id whose change is in flight. */
	busy = $state<string | null>(null);

	async load() {
		this.items = (await api<{ pins: Pin[] }>('/api/pins', { interaction: true })).pins;
	}
	find(targetType: Pin['targetType'], targetId: string) {
		return this.items.find((pin) => pin.targetType === targetType && pin.targetId === targetId);
	}
	async remove(pin: Pin) {
		this.busy = pin.targetId;
		try {
			await api(`/api/pins/${pin.id}`, { method: 'DELETE' });
			this.items = this.items.filter((item) => item.id !== pin.id);
		} finally {
			this.busy = null;
		}
	}
	async toggle(targetType: Pin['targetType'], targetId: string) {
		const existing = this.find(targetType, targetId);
		if (existing) return this.remove(existing);
		this.busy = targetId;
		try {
			const { pin } = await api<{ pin: Pin }>('/api/pins', { body: { targetType, targetId } });
			this.items = [pin, ...this.items];
		} finally {
			this.busy = null;
		}
	}
}
