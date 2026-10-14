import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import {
	citedTextSchema,
	idSchema,
	projectInput,
	quizSchema,
	sourceReadInput,
	sourceSearchInput,
	textSourceInput
} from '../../domain';
import { origin } from '../config';
import { createProject, listProjects, projectWorkspace } from '../endpoints/projects';
import { conversationDetails, outputDetails } from '../endpoints/study';
import { addTextSource, readSource, saveOverview, saveQuiz, searchSources } from '../sources';
import { guard } from './result';

const projectId = idSchema.describe('Project ID from list_projects.');
const readOnly = { readOnlyHint: true };
const additive = { destructiveHint: false };

export function registerStudyTools(server: McpServer, author: string) {
	server.registerTool(
		'list_projects',
		{
			title: 'List projects',
			description:
				'Lists all projects (courses, research topics, meetings), most recently updated first.',
			annotations: readOnly
		},
		() =>
			guard(async () => ({
				projects: (await listProjects()).map(({ id, name, description, updatedAt }) => ({
					id,
					name,
					description,
					updatedAt
				}))
			}))
	);
	server.registerTool(
		'get_project',
		{
			title: 'Get project',
			description:
				"Returns a project's sources (with status and whether their text is readable), saved overviews and quizzes, and chats.",
			inputSchema: z.object({ projectId }),
			annotations: readOnly
		},
		({ projectId }) =>
			guard(async () => {
				const workspace = await projectWorkspace(projectId);
				const readable = new Set(workspace.readableMaterialIds);
				return {
					project: workspace.project,
					url: `${origin()}/projects/${workspace.project.id}`,
					sources: workspace.materials.map((m) => ({
						id: m.id,
						name: m.name,
						kind: m.kind,
						mimeType: m.mimeType,
						status: m.status,
						readable: readable.has(m.id),
						durationMs: m.durationMs,
						sourceUrl: m.sourceUrl,
						notes: m.notes,
						createdAt: m.createdAt
					})),
					outputs: workspace.outputs.map(({ id, kind, title, modelId, createdAt }) => ({
						id,
						kind: kind === 'summary' ? 'overview' : kind,
						title,
						author: modelId,
						createdAt
					})),
					conversations: workspace.conversations.map(({ id, title, updatedAt }) => ({
						id,
						title,
						updatedAt
					}))
				};
			})
	);
	server.registerTool(
		'search_sources',
		{
			title: 'Search sources',
			description:
				'Full-text search across the extracted text of all sources, or of one project or chosen sources. Returns the best-matching chunks with their locators and a highlighted snippet.',
			inputSchema: sourceSearchInput,
			annotations: readOnly
		},
		(input) => guard(async () => ({ results: await searchSources(input) }))
	);
	server.registerTool(
		'read_source',
		{
			title: 'Read source',
			description:
				"Reads a source's extracted text in order, chunk by chunk with locators, from the start, a chunk offset or a locator. Continue with nextOffset until it is null.",
			inputSchema: sourceReadInput,
			annotations: readOnly
		},
		(input) => guard(() => readSource(input))
	);
	server.registerTool(
		'get_output',
		{
			title: 'Get overview, quiz, audio summary or study session',
			description:
				'Returns a saved overview (markdown with citations), quiz (questions, answer key, rubrics and explanations) with its attempts and grades, audio summary (transcript with citations, style (narration or tutor and learner dialogue), voices and duration), or spoken study session (plan with questions, key points and model answers) with its runs and graded answers.',
			inputSchema: z.object({
				outputId: idSchema.describe(
					'Overview, quiz, audio summary or study session ID from get_project.'
				)
			}),
			annotations: readOnly
		},
		({ outputId }) => guard(() => outputDetails(outputId))
	);
	server.registerTool(
		'get_conversation',
		{
			title: 'Get chat',
			description: "Returns a project chat's messages, oldest first, with their citations.",
			inputSchema: z.object({ conversationId: idSchema.describe('Chat ID from get_project.') }),
			annotations: readOnly
		},
		({ conversationId }) => guard(() => conversationDetails(conversationId))
	);
	server.registerTool(
		'create_project',
		{
			title: 'Create project',
			description: 'Creates a project. Check list_projects first to avoid duplicates.',
			inputSchema: projectInput,
			annotations: additive
		},
		(input) => guard(async () => ({ project: await createProject(input) }))
	);
	server.registerTool(
		'add_text_source',
		{
			title: 'Add text source',
			description:
				'Adds text you write (notes, a summary, a transcript) to a project as a source. It is readable, searchable and citable immediately, and appears in Studyloom like an upload.',
			inputSchema: textSourceInput.safeExtend({ projectId }),
			annotations: additive
		},
		({ projectId, ...input }) => guard(() => addTextSource(projectId, input, author))
	);
	server.registerTool(
		'save_overview',
		{
			title: 'Save overview',
			description:
				'Saves an overview you wrote (markdown) to a project, where it appears next to Studyloom overviews. Every citation must name a readable source of this project and one of its locators; quotes must be exact.',
			inputSchema: citedTextSchema.extend({ projectId }),
			annotations: additive
		},
		({ projectId, ...input }) => guard(() => saveOverview(projectId, input, author))
	);
	server.registerTool(
		'save_quiz',
		{
			title: 'Save quiz',
			description:
				'Saves a quiz you wrote to a project so it can be taken and graded in Studyloom. Multiple-choice answers must equal one option exactly; written questions need a rubric. Every question needs at least one valid citation.',
			inputSchema: z.object({ projectId, quiz: quizSchema }),
			annotations: additive
		},
		({ projectId, quiz }) => guard(() => saveQuiz(projectId, quiz, author))
	);
}
