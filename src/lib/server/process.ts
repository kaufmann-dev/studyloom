import { spawn } from 'node:child_process';
export function runProcess(
	command: string,
	args: string[],
	options: {
		cwd?: string;
		env?: NodeJS.ProcessEnv;
		signal?: AbortSignal;
		timeoutMs?: number;
		maxBytes?: number;
		onLine?: (line: string) => void;
		stderrTail?: { text: string };
	} = {}
) {
	return new Promise<string>((resolve, reject) => {
		const child = spawn(command, args, {
			cwd: options.cwd,
			env: options.env ?? process.env,
			stdio: ['ignore', 'pipe', 'pipe'],
			detached: true
		});
		let output = '',
			stderr = '',
			pending = '',
			bytes = 0,
			problem: Error | undefined;
		const kill = () => {
			try {
				if (child.pid) process.kill(-child.pid, 'SIGKILL');
			} catch {
				child.kill('SIGKILL');
			}
		};
		const abort = () => {
			problem = new Error('Operation cancelled.');
			kill();
		};
		const timer = setTimeout(() => {
			problem = new Error('Operation timed out.');
			kill();
		}, options.timeoutMs ?? 120_000);
		options.signal?.addEventListener('abort', abort, { once: true });
		if (options.signal?.aborted) abort();
		// Decoded as streams, so a character split across two chunks stays whole.
		child.stdout.setEncoding('utf8');
		child.stderr.setEncoding('utf8');
		child.stdout.on('data', (chunk: string) => {
			bytes += Buffer.byteLength(chunk);
			if (bytes > (options.maxBytes ?? 8 * 1024 * 1024)) {
				problem = new Error('Tool output exceeded its limit.');
				kill();
				return;
			}
			output += chunk;
			if (options.onLine) {
				pending += chunk;
				let end;
				while ((end = pending.indexOf('\n')) >= 0) {
					options.onLine(pending.slice(0, end));
					pending = pending.slice(end + 1);
				}
			}
		});
		child.stderr.on('data', (chunk: string) => {
			stderr = (stderr + chunk).slice(-8000);
		});
		const clean = () => {
			clearTimeout(timer);
			options.signal?.removeEventListener('abort', abort);
		};
		child.on('error', (e) => {
			clean();
			reject(e);
		});
		child.on('close', (code) => {
			clean();
			if (pending) options.onLine?.(pending);
			if (options.stderrTail) options.stderrTail.text = stderr;
			if (problem) reject(problem);
			else if (code !== 0) reject(new Error(`${command} exited with ${code}: ${stderr}`));
			else resolve(output);
		});
	});
}
