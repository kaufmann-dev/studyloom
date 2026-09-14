import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
const dir = await mkdtemp(join(tmpdir(), 'studyloom-sandbox-'));
try {
	for (const [command, args] of [
		['bwrap', ['--version']],
		['prlimit', ['--version']],
		['ffmpeg', ['-version']],
		['libreoffice', ['--headless', '--version']],
		['pdftotext', ['-v']],
		['tesseract', ['--version']],
		['python3', ['--version']],
		['muse', ['--version']]
	]) {
		const result = spawnSync(command, args, { timeout: 30000, encoding: 'utf8' });
		if (result.error || result.status !== 0)
			throw new Error(`${command} is unavailable in the app runtime.`);
	}
	await writeFile(
		join(dir, 'probe.py'),
		'import os,socket\nassert not os.path.exists("/data")\nassert not os.path.exists("/code")\nassert "TRANSCRIPTION_API_KEY" not in os.environ\ns=socket.socket()\ns.settimeout(1)\ntry:\n s.connect(("1.1.1.1",443))\nexcept OSError:\n print("sandbox isolation verified")\nelse:\n raise RuntimeError("sandbox has network access")\n'
	);
	const result = spawnSync(
		'bwrap',
		[
			'--unshare-all',
			'--die-with-parent',
			'--new-session',
			'--ro-bind',
			'/usr',
			'/usr',
			'--ro-bind',
			'/bin',
			'/bin',
			'--ro-bind',
			'/lib',
			'/lib',
			'--ro-bind',
			'/lib64',
			'/lib64',
			'--proc',
			'/proc',
			'--dev',
			'/dev',
			'--tmpfs',
			'/tmp',
			'--bind',
			dir,
			'/work',
			'--clearenv',
			'--setenv',
			'PATH',
			'/usr/bin:/bin',
			'--',
			'/usr/bin/python3',
			'/work/probe.py'
		],
		{ encoding: 'utf8', timeout: 10000 }
	);
	if (result.error || result.status !== 0)
		throw new Error(
			'The deployment runtime cannot create an isolated processing sandbox: ' +
				(result.stderr || result.error)
		);
	console.log(result.stdout.trim());
} finally {
	await rm(dir, { recursive: true, force: true });
}
