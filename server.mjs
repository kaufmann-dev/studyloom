import { existsSync } from 'node:fs';
if (existsSync('.env')) process.loadEnvFile('.env');
process.env.BODY_SIZE_LIMIT ??= '10M';
const { createServer } = await import('node:http');
const { handler } = await import('./build/handler.js');
const { attachRuntime } = await import('./build/runtime/runtime.js');
const server = createServer(handler);
const shutdown = await attachRuntime(server);
const port = Number(process.env.PORT || 3000);
server.listen(port, process.env.HOST || '0.0.0.0', () =>
	console.log(`Studyloom listening on port ${port}`)
);
let stopping = false;
for (const signal of ['SIGINT', 'SIGTERM'])
	process.on(signal, async () => {
		if (stopping) return;
		stopping = true;
		server.close();
		await shutdown();
		process.exit(0);
	});
