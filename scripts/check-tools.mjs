import { spawnSync } from 'node:child_process';

for (const [command, args] of [
	['ffmpeg', ['-version']],
	['ffprobe', ['-version']],
	['libreoffice', ['--headless', '--version']],
	['pdftotext', ['-v']],
	['pdftoppm', ['-v']],
	['pdfimages', ['-v']],
	['tesseract', ['--version']],
	['python3', ['--version']]
]) {
	const result = spawnSync(command, args, { timeout: 30000, encoding: 'utf8' });
	if (result.error || result.status !== 0)
		throw new Error(`${command} is unavailable in the app runtime.`);
}

console.log('processing tools verified');
