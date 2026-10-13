import { speechCatalog } from '../elevenlabs';
import type { Handler } from './http';

/** The ElevenLabs voices and speech models offered for audio summaries. */
export const speech: Handler = async ({ method, id }) => {
	if (id || method !== 'GET') return;
	return Response.json(await speechCatalog());
};
