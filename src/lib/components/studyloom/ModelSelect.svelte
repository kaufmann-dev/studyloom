<script lang="ts" module>
	import { DEFAULT_MODEL, type MuseModel } from '#lib/domain.js';

	/** The preferred model when the account still offers it, otherwise the first available one. */
	export function availableModel(models: MuseModel[], preferred: string): string {
		return (
			models.find((model) => model.modelId === preferred)?.modelId ??
			models[0]?.modelId ??
			DEFAULT_MODEL
		);
	}
</script>

<script lang="ts">
	import type { HTMLSelectAttributes } from 'svelte/elements';
	import * as NativeSelect from '#lib/components/ui/native-select/index.js';

	let {
		models,
		value = $bindable(),
		class: className = 'w-full',
		...rest
	}: Omit<HTMLSelectAttributes, 'size' | 'value'> & {
		models: MuseModel[];
		value: string;
		class?: string;
	} = $props();
</script>

<NativeSelect.Root
	{...rest}
	class={className}
	bind:value={() => availableModel(models, value), (next) => (value = next)}
>
	{#each models as model (model.modelId)}
		<NativeSelect.Option value={model.modelId}>{model.displayLabel}</NativeSelect.Option>
	{:else}
		<NativeSelect.Option value={DEFAULT_MODEL}>{DEFAULT_MODEL}</NativeSelect.Option>
	{/each}
</NativeSelect.Root>
