import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import * as schema from './schema';
import { required } from '../config';
let client: ReturnType<typeof postgres> | undefined;
let database: ReturnType<typeof createDatabase> | undefined;
function createDatabase() {
	client = postgres(required('DATABASE_URL'), { max: 10, onnotice: () => {} });
	return drizzle(client, { schema });
}
export function db() {
	return (database ??= createDatabase());
}
function migrationsFolder() {
	const here = dirname(fileURLToPath(import.meta.url));
	const candidates = [
		join(process.cwd(), 'drizzle'),
		join(here, '../../drizzle'),
		join(here, '../../../../drizzle')
	];
	const folder = candidates.find((candidate) =>
		existsSync(join(candidate, 'meta/_journal.json'))
	);
	if (!folder) throw new Error('Cannot locate the drizzle migrations folder.');
	return folder;
}
export async function migrateDatabase() {
	await migrate(db(), { migrationsFolder: migrationsFolder() });
}
export async function closeDatabase() {
	await client?.end();
	database = undefined;
	client = undefined;
}
