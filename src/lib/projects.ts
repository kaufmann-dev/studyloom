import type { Project, ProjectSort } from './domain';

export const PROJECT_SORTS: Record<ProjectSort, string> = {
	updated: 'Recently updated',
	name: 'Name',
	lecturer: 'Lecturer'
};

export const isProjectSort = (value: string | null): value is ProjectSort =>
	value !== null && Object.hasOwn(PROJECT_SORTS, value);

const compareText = (a: string, b: string) =>
	a.localeCompare(b, undefined, { sensitivity: 'base', numeric: true });

/**
 * Orders projects for the projects list. By lecturer, a project files under its first listed
 * lecturer; projects without lecturers come last.
 */
export function sortProjects(projects: readonly Project[], sort: ProjectSort): Project[] {
	const sorted = [...projects];
	if (sort === 'updated')
		return sorted.sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
	if (sort === 'name') return sorted.sort((a, b) => compareText(a.name, b.name));
	return sorted.sort((a, b) => {
		const first = a.lecturers[0]?.name;
		const second = b.lecturers[0]?.name;
		if (first === undefined || second === undefined) {
			if (first !== second) return first === undefined ? 1 : -1;
		} else {
			const byLecturer = compareText(first, second);
			if (byLecturer) return byLecturer;
		}
		return compareText(a.name, b.name);
	});
}
