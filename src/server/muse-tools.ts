import { McpServer } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { z } from 'zod';
import { readFile, stat } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';
import { runCommand } from '../lib/server/commands';
import { scopedFile } from '../lib/server/storage';
import { transcribeFile } from '../lib/server/transcribe';
// Muse starts stdio MCP children in the explicit workspace and does not inherit custom environment variables.
const files = resolve(process.cwd());
if (basename(files) !== 'files') throw new Error('MCP must start in a job workspace.');
const jobDir = dirname(files);
const result = (value: unknown) => ({
	content: [
		{ type: 'text' as const, text: typeof value === 'string' ? value : JSON.stringify(value) }
	]
});
function createServer() {
	const server = new McpServer({ name: 'studyloom', version: '1.0.0' });
	server.registerTool(
		'run_command',
		{
			description:
				'Run a shell command or Python script with the job workspace as the working directory. Installed tools include Python3, FFmpeg/ffprobe, LibreOffice, pdftotext/pdftoppm/pdfinfo and Tesseract. Choose the tools needed for the actual source; do not assume any file format is readable. Use relative paths. App secrets are never passed to commands. Write extracted.json as your final ingestion artifact.',
			inputSchema: z.object({ command: z.string().min(1).max(100000) })
		},
		async ({ command }) => result(await runCommand(jobDir, command))
	);
	server.registerTool(
		'read_file',
		{
			description:
				'Read up to 200,000 characters from a UTF-8 workspace file. Paths are relative to the workspace root.',
			inputSchema: z.object({ path: z.string(), offset: z.number().int().nonnegative().default(0) })
		},
		async ({ path, offset }) => {
			const file = await scopedFile(files, path);
			if ((await stat(file)).size > 32 * 1024 * 1024)
				throw new Error('Use run_command to extract a smaller portion.');
			return result((await readFile(file, 'utf8')).slice(offset, offset + 200000));
		}
	);
	server.registerTool(
		'view_image',
		{
			description:
				'Inspect a PNG/JPEG/WebP image from the workspace. Use this to read diagrams, images, scanned pages and slide renders. Resize very large images using tools first.',
			inputSchema: z.object({
				path: z.string(),
				mimeType: z.enum(['image/png', 'image/jpeg', 'image/webp'])
			})
		},
		async ({ path, mimeType }) => {
			const file = await scopedFile(files, path);
			if ((await stat(file)).size > 8 * 1024 * 1024)
				throw new Error('Resize the image below 8 MiB.');
			return {
				content: [
					{ type: 'image' as const, mimeType, data: (await readFile(file)).toString('base64') }
				]
			};
		}
	);
	server.registerTool(
		'transcribe_audio',
		{
			description:
				'Transcribe a workspace WAV with Meta Muse Voice Transcribe API. This incurs API usage. Supply mono signed 16-bit PCM WAV at 16 or 24 kHz, max ten minutes and 32 MiB. For other audio/video, choose conversion and splitting commands with FFmpeg. Returns transcript turns and clip-relative timestamps. Add each clip offset to locators yourself.',
			inputSchema: z.object({ path: z.string() })
		},
		async ({ path }) => result(await transcribeFile(await scopedFile(files, path)))
	);
	return server;
}
serveStdio(createServer);
