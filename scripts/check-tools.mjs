import { spawnSync } from 'node:child_process';

for (const [command, args] of [
	['ffmpeg', ['-version']],
	['ffprobe', ['-version']],
	['libreoffice', ['--headless', '--version']],
	['pdftotext', ['-v']],
	['pdftoppm', ['-v']],
	['pdfinfo', ['-v']],
	['tesseract', ['--version']],
	['/usr/bin/python3', ['-c', 'import uno']]
]) {
	const result = spawnSync(command, args, { timeout: 30000, encoding: 'utf8' });
	if (result.error || result.status !== 0)
		throw new Error(`${command} is unavailable in the app runtime.`);
}

console.log('processing tools verified');
