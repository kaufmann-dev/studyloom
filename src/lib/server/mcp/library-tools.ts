import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { idSchema, libraryInput, libraryPatchInput, librarySearchInput } from '../../domain';
import {
	createLibraryEntry,
	libraryListing,
	searchLibrary,
	updateLibraryEntry
} from '../endpoints/library';
import { guard } from './result';

const itemId = idSchema.describe('Library item ID from browse_library or search_library.');
const FIELDS =
	'parentId is a folder ID, or null for the top level. Links use url and notes; contacts use phone, email, website and notes; notes keep their body in text.';

export function registerLibraryTools(server: McpServer) {
	server.registerTool(
		'browse_library',
		{
			title: 'Browse Library',
			description:
				'Without itemId, lists the top level of the Library. With a folder ID, returns the folder, its path and its children; with any other item, returns that item in full (including a note text).',
			inputSchema: z.object({ itemId: itemId.optional() }),
			annotations: { readOnlyHint: true }
		},
		({ itemId }) => guard(() => libraryListing(itemId))
	);
	server.registerTool(
		'search_library',
		{
			title: 'Search Library',
			description:
				'Finds Library items whose name, note text, notes, URL or contact details contain the query (case-insensitive), with a short excerpt.',
			inputSchema: librarySearchInput,
			annotations: { readOnlyHint: true }
		},
		(input) => guard(async () => ({ items: await searchLibrary(input) }))
	);
	server.registerTool(
		'create_library_item',
		{
			title: 'Create Library item',
			description: `Creates a folder, link, contact or note in the Library. ${FIELDS}`,
			inputSchema: libraryInput,
			annotations: { destructiveHint: false }
		},
		(input) => guard(async () => ({ item: await createLibraryEntry(input) }))
	);
	server.registerTool(
		'update_library_item',
		{
			title: 'Update Library item',
			description: `Changes the given fields of a Library item, or moves it with parentId; omitted fields stay. Files can only be renamed or moved. ${FIELDS}`,
			inputSchema: libraryPatchInput.extend({ itemId })
		},
		({ itemId, ...patch }) => guard(async () => ({ item: await updateLibraryEntry(itemId, patch) }))
	);
}
