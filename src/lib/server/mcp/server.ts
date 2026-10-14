import { McpServer, type AuthInfo } from '@modelcontextprotocol/server';
import { registerLibraryTools } from './library-tools';
import { registerPlannerTools } from './planner-tools';
import { registerStudyTools } from './study-tools';

const INSTRUCTIONS = `Studyloom is a private study workspace.

Projects hold the material for one course, research topic or meeting. Their sources (uploaded
files and lecture recordings) are extracted into text chunks, each with a unique locator such as
"page:3", "slide:4" or "time:120000-150000" (milliseconds). Find evidence with search_sources,
then read around it with read_source; get_project lists a project's sources, overviews, quizzes
and chats.

When you use source material, cite it as materialId plus locator. A quote must be an exact
substring of that chunk's text. save_overview and save_quiz reject citations that do not match,
so take locators from search_sources or read_source. add_text_source stores text you write as a
new, immediately searchable source.

Tasks and calendar events use wall-clock dates and times without time zones: YYYY-MM-DD and
HH:MM. An empty time means none (an all-day event, or a task due some time that day). Changing a
repeating event's start date or repeat drops its single-occurrence changes; use
update_occurrence to change or cancel one occurrence.

The Library is separate from projects: folders, notes, links, contacts and stored files. The
contents of Library files are not readable here.`;

/** The name shown as the author of what a connection saves, such as "Claude". */
const clientLabel = (authInfo: AuthInfo | undefined) =>
	String(authInfo?.extra?.clientName ?? 'MCP client');

/** One server per request, acting for the connection the access token belongs to. */
export function createMcpServer(authInfo: AuthInfo | undefined) {
	const server = new McpServer(
		{ name: 'studyloom', version: '1.0.0' },
		{ instructions: INSTRUCTIONS }
	);
	registerStudyTools(server, clientLabel(authInfo));
	registerPlannerTools(server);
	registerLibraryTools(server);
	return server;
}
