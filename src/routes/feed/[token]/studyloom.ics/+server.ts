import { error } from '@sveltejs/kit';
import { feedResponse } from '#lib/server/endpoints/calendar.js';

// Calendar apps cannot sign in, so the secret token in the path is the only authorisation.
export async function GET({ params }: { params: { token: string } }) {
	return (await feedResponse(params.token)) ?? error(404, 'Calendar feed not found.');
}
