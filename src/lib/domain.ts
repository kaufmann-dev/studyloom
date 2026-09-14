import { z } from 'zod';
export const DEFAULT_MODEL = 'muse-spark-1.3-contributor';
export const TRANSCRIPTION_MODEL = 'muse-voice-transcribe-1.0';
export const UPLOAD_CHUNK_SIZE = 8 * 1024 * 1024;
export const idSchema = z.uuid();
export const projectInput = z.object({
	name: z.string().trim().min(1).max(160),
	description: z.string().trim().max(4000).default('')
});
export const sourceSelection = z.array(idSchema).min(1).max(500);
export const citationSchema = z.object({
	materialId: idSchema,
	locator: z.string().max(300),
	quote: z.string().max(2000).optional()
});
export const questionSchema = z
	.object({
		id: z.string().min(1).max(80),
		type: z.enum(['multiple_choice', 'written']),
		question: z.string().min(1).max(6000),
		options: z.array(z.string().min(1).max(2000)).max(8).default([]),
		correctAnswer: z.string().min(1).max(6000),
		rubric: z.string().min(1).max(6000),
		explanation: z.string().max(6000),
		citations: z.array(citationSchema).min(1).max(20)
	})
	.superRefine((q, ctx) => {
		if (
			q.type === 'multiple_choice' &&
			(q.options.length < 2 || !q.options.includes(q.correctAnswer))
		)
			ctx.addIssue({
				code: 'custom',
				message: 'Multiple-choice answers must exactly match an option.'
			});
		if (new Set(q.options).size !== q.options.length)
			ctx.addIssue({ code: 'custom', message: 'Answer options must be distinct.' });
		if (q.type === 'written' && q.options.length)
			ctx.addIssue({ code: 'custom', message: 'Written questions cannot contain options.' });
	});
export const quizSchema = z
	.object({ title: z.string().min(1).max(200), questions: z.array(questionSchema).min(1).max(50) })
	.superRefine((v, ctx) => {
		if (new Set(v.questions.map((q) => q.id)).size !== v.questions.length)
			ctx.addIssue({ code: 'custom', message: 'Question IDs must be unique.' });
	});
export const generationInput = z.object({
	kind: z.enum(['summary', 'quiz']),
	materialIds: sourceSelection,
	modelId: z.string().min(1).max(160).default(DEFAULT_MODEL),
	questionCount: z.number().int().min(1).max(50).default(10),
	questionMix: z.enum(['mixed', 'multiple_choice', 'written']).default('mixed')
});
export const chatInput = z.object({
	conversationId: idSchema.optional(),
	message: z.string().trim().min(1).max(30000),
	materialIds: sourceSelection,
	modelId: z.string().min(1).max(160).default(DEFAULT_MODEL)
});
export const answersSchema = z.object({
	answers: z
		.array(z.object({ questionId: z.string().min(1), value: z.string().max(12000) }))
		.min(1)
		.max(50)
});
export const chunkResultSchema = z.object({
	locator: z.string().min(1).max(300),
	text: z.string().min(1).max(60000)
});
export const ingestionSchema = z
	.object({
		status: z.enum(['ready', 'partial', 'unreadable']),
		notes: z.string().max(10000),
		chunks: z.array(chunkResultSchema).max(20000),
		assets: z
			.array(
				z.object({
					path: z.string().min(1).max(500),
					label: z.string().max(200),
					mimeType: z.string().max(100),
					locator: z.string().max(300)
				})
			)
			.max(2000)
			.default([])
	})
	.superRefine((r, ctx) => {
		if (r.status === 'ready' && !r.chunks.length)
			ctx.addIssue({ code: 'custom', message: 'Readable content is required for ready status.' });
	});
export type Citation = z.infer<typeof citationSchema>;
export type Quiz = z.infer<typeof quizSchema>;
export type Question = z.infer<typeof questionSchema>;
export type JobStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';
export interface Project {
	id: string;
	name: string;
	description: string;
	createdAt: string;
	updatedAt: string;
}
export interface Material {
	id: string;
	projectId: string;
	name: string;
	filename: string;
	mimeType: string;
	kind: 'file' | 'recording';
	status: 'uploading' | 'processing' | 'ready' | 'partial' | 'failed' | 'recording' | 'paused';
	size: number;
	receivedBytes: number;
	durationMs: number;
	notes: string;
	createdAt: string;
	updatedAt: string;
}
export interface SourceChunk {
	id: string;
	materialId: string;
	ordinal: number;
	locator: string;
	text: string;
}
export interface TranscriptTurn {
	id: string;
	materialId: string;
	segmentId: string;
	turnId: number;
	startMs: number;
	endMs: number;
	text: string;
	speaker: string | null;
}
export interface Asset {
	id: string;
	materialId: string;
	label: string;
	mimeType: string;
	locator: string;
}
export interface Conversation {
	id: string;
	projectId: string;
	title: string;
	materialIds: string[];
	modelId: string;
	createdAt: string;
	updatedAt: string;
}
export interface Message {
	id: string;
	conversationId: string;
	role: 'user' | 'assistant';
	content: string;
	citations: Citation[];
	modelId: string | null;
	createdAt: string;
}
export interface StudyOutput {
	id: string;
	projectId: string;
	kind: 'summary' | 'quiz';
	title: string;
	content: string;
	quiz: Quiz | null;
	citations: Citation[];
	materialIds: string[];
	modelId: string;
	createdAt: string;
}
export interface Grade {
	questionId: string;
	score: number;
	maxScore: number;
	feedback: string;
	correctAnswer: string;
	citations: Citation[];
}
export interface QuizAttempt {
	id: string;
	outputId: string;
	answers: { questionId: string; value: string }[];
	grades: Grade[];
	score: number | null;
	maxScore: number;
	status: 'grading' | 'complete' | 'failed';
	createdAt: string;
}
export interface Job {
	id: string;
	projectId: string;
	materialId: string | null;
	kind: string;
	status: JobStatus;
	progress: string;
	error: string | null;
	outputId: string | null;
	conversationId: string | null;
	attemptId: string | null;
	createdAt: string;
	updatedAt: string;
}
export interface MuseAccount {
	state: string;
	label?: string;
	credentialRequired: boolean;
}
export interface MuseModel {
	modelId: string;
	displayLabel: string;
	contextLimit: number | null;
	description: string | null;
}
