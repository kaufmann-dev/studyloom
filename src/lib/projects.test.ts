import { describe, expect, it } from 'vitest';
import type { Project } from './domain';
import { isProjectSort, sortProjects } from './projects';

const project = (name: string, updatedAt: string, lecturers: string[] = []): Project => ({
	id: name,
	name,
	course: '',
	lecturers: lecturers.map((lecturer) => ({ id: lecturer, name: lecturer })),
	description: '',
	createdAt: updatedAt,
	updatedAt
});

const projects = [
	project('ABWL', '2026-11-11T10:00:00Z', ['Geissler']),
	project('Advanced AI Leader', '2026-11-12T10:00:00Z', ['Kalam', 'Hetfleisch']),
	project('Kurs II', '2026-10-08T10:00:00Z'),
	project('KI-Videos', '2026-11-11T09:00:00Z', ['hetfleisch'])
];
const names = (list: Project[]) => list.map((item) => item.name);

describe('sortProjects', () => {
	it('lists the most recently updated first', () => {
		expect(names(sortProjects(projects, 'updated'))).toEqual([
			'Advanced AI Leader',
			'ABWL',
			'KI-Videos',
			'Kurs II'
		]);
	});
	it('sorts by name regardless of case', () => {
		expect(names(sortProjects(projects, 'name'))).toEqual([
			'ABWL',
			'Advanced AI Leader',
			'KI-Videos',
			'Kurs II'
		]);
	});
	it('sorts by first lecturer, then name, with unassigned projects last', () => {
		expect(names(sortProjects(projects, 'lecturer'))).toEqual([
			'ABWL',
			'KI-Videos',
			'Advanced AI Leader',
			'Kurs II'
		]);
	});
	it('does not change the given list', () => {
		const copy = [...projects];
		sortProjects(projects, 'name');
		expect(projects).toEqual(copy);
	});
});

describe('isProjectSort', () => {
	it('accepts only known orders', () => {
		expect(isProjectSort('lecturer')).toBe(true);
		expect(isProjectSort('constructor')).toBe(false);
		expect(isProjectSort(null)).toBe(false);
	});
});
