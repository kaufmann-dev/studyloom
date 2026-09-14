import { drizzle } from 'drizzle-orm/postgres-js';
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
export async function closeDatabase() {
	await client?.end();
	database = undefined;
	client = undefined;
}
