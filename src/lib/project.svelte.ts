import { createContext } from 'svelte';
import { SvelteMap } from 'svelte/reactivity';
import { availableModel } from './components/studyloom/ModelSelect.svelte';
import {
	DEFAULT_MODEL,
	isActiveJob,
	isReadable,
	type ClaudeModel,
	type ClaudeStatus,
	type Job,
	type ProjectMaterial,
	type ProjectWorkspace
} from './domain';
import { canResumeReview } from './sources';
import { createPoller } from './polling';
import { BrowserRecorder } from './recording/recorder.svelte';
import { api, errorText } from './ui';

/**
 * One open project, shared by its pages: the polled workspace, the Claude models and the sources
 * chosen for chat and study tools.
 */
export class ProjectState {
	readonly projectId: string;
	data = $state.raw<ProjectWorkspace | null>(null);
	error = $state('');
	models = $state.raw<ClaudeModel[]>([]);
	claudeNotice = $state('');
	/** The model the user picked for processing sources, while Claude still offers it. */
	preferredModel = $state(DEFAULT_MODEL);
	/** Ids of the sources that chat and study tools work with. */
	selected = $state<string[]>([]);
	/** Lives as long as the project is open, so a recording survives moving between its pages. */
	readonly recorder = new BrowserRecorder();
	/** Set when leaving the project was stopped because a recording is not saved yet. */
	leaveWarning = $state(false);
	readonly processingModel = $derived(availableModel(this.models, this.preferredModel));
	readonly materials = $derived(this.data?.materials ?? []);
	readonly ingestJobs = $derived.by(() => {
		const latest = new SvelteMap<string, Job>();
		for (const job of this.data?.jobs ?? []) {
			if (job.kind === 'ingest' && job.materialId && !latest.has(job.materialId))
				latest.set(job.materialId, job);
		}
		return latest;
	});
	readonly readable = $derived(this.materials.filter(isReadable));

	// Guards against a slow response overwriting a newer one.
	#version = 0;
	// Sources that became readable since the last refresh are selected automatically.
	#knownReadable: string[] = [];
	readonly #poller = createPoller(async (interaction) => {
		const version = ++this.#version;
		try {
			const result = await api<ProjectWorkspace>(`/api/projects/${this.projectId}`, {
				interaction
			});
			if (version !== this.#version) return false;
			this.data = result;
			this.error = '';
			const available = result.materials.filter(isReadable).map((material) => material.id);
			this.selected = [
				...this.selected.filter((id) => available.includes(id)),
				...available.filter(
					(id) => !this.#knownReadable.includes(id) && !this.selected.includes(id)
				)
			];
			this.#knownReadable = available;
			return (
				result.jobs.some(isActiveJob) ||
				result.materials.some(
					(material) =>
						material.status === 'recording' ||
						(material.status === 'processing' &&
							this.ingestJobs.get(material.id)?.status !== 'paused')
				)
			);
		} catch (cause) {
			this.error = errorText(cause);
			return false;
		}
	});

	processSource(material: ProjectMaterial) {
		const job = this.ingestJobs.get(material.id);
		if (job && canResumeReview(job)) return api(`/api/jobs/${job.id}/retry`, { body: {} });
		return api(`/api/materials/${material.id}/process`, {
			body: { modelId: this.processingModel }
		});
	}

	constructor(projectId: string) {
		this.projectId = projectId;
	}

	/** Reloads the project and keeps polling while jobs or recordings are active. */
	refresh = (interaction = false) => this.#poller.run(interaction);

	/** Loads the project, the Claude models and the recorder; the returned function ends all three. */
	start() {
		void this.refresh(true);
		void this.#loadModels();
		void this.recorder.initialize(this.projectId);
		return () => {
			this.#poller.stop();
			this.recorder.destroy();
		};
	}

	async #loadModels() {
		try {
			const status = await api<ClaudeStatus>('/api/claude');
			this.models = status.models;
			this.claudeNotice =
				status.error ?? (status.configured ? '' : 'Claude is not set up. See Settings.');
		} catch (cause) {
			this.claudeNotice = errorText(cause);
		}
	}
}

export const [getProject, setProject] = createContext<ProjectState>();
