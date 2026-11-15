import { describe, expect, it } from 'vitest';
import type { Snapshot } from '../domain';
import {
	figuresIn,
	partCharacters,
	useOutputImages,
	validateOutline,
	wholeOutline
} from './outline';

const materialId = '00000000-0000-4000-8000-000000000001';
const figure = '11111111-1111-4111-8111-111111111111';
const snapshot: Snapshot = [
	{
		id: materialId,
		name: 'Script',
		chunks: [
			{ locator: 'page:1', kind: 'text', text: 'Markets.' },
			{ locator: 'page:2', kind: 'text', text: 'Companies and their partners.' },
			{ locator: 'page:3#1', kind: 'exercise', text: '1. Which market?' },
			{ locator: 'page:3#2', kind: 'exercise', text: '2. Which partner?' },
			{ locator: 'page:9', kind: 'solution', text: '1. - [x] Sales market' }
		],
		figures: [{ id: figure, label: 'Cycle', locator: 'page:1', mimeType: 'image/png' }]
	}
];
const ref = (locator: string) => ({ materialId, locator });
const outline = (exercises: string[], locators = ['page:1', 'page:2']) => ({
	title: 'Script',
	parts: [
		{
			title: 'Markets',
			sections: [{ title: 'Basics', locators: locators.map(ref), exercises: exercises.map(ref) }]
		}
	]
});

describe('outlines', () => {
	it('accept only chunks of the sources and never ask an exercise twice', () => {
		expect(() => validateOutline(outline(['page:3#1']), snapshot, 'standard')).not.toThrow();
		expect(() => validateOutline(outline([], ['page:7']), snapshot, 'standard')).toThrow('page:7');
		expect(() => validateOutline(outline(['page:1']), snapshot, 'standard')).toThrow('exercise');
		expect(() => validateOutline(outline(['page:3#1', 'page:3#1']), snapshot, 'standard')).toThrow(
			'more than one'
		);
	});
	it('require every exercise at comprehensive coverage', () => {
		expect(() => validateOutline(outline(['page:3#1']), snapshot, 'comprehensive')).toThrow(
			'1 of 2 exercises'
		);
		expect(() =>
			validateOutline(outline(['page:3#1', 'page:3#2']), snapshot, 'comprehensive')
		).not.toThrow();
		// The outline made without Claude for small sources passes its own rules.
		const whole = wholeOutline(snapshot);
		expect(() => validateOutline(whole, snapshot, 'comprehensive')).not.toThrow();
		expect(partCharacters(whole.parts[0], snapshot)).toBe(
			'Markets.'.length + 'Companies and their partners.'.length + '1. - [x] Sales market'.length
		);
	});
});

describe('figures in generated text', () => {
	it('allow only figures of the sources and point them at the output', () => {
		const text = `See ![Cycle](asset:${figure}).`;
		expect(figuresIn(text, snapshot)).toEqual([figure]);
		expect(useOutputImages(text)).toBe(`See ![Cycle](image:${figure}).`);
		expect(() => figuresIn('![x](https://example.com/x.png)', snapshot)).toThrow('not a figure');
		expect(() => figuresIn('![x](asset:22222222-2222-4222-8222-222222222222)', snapshot)).toThrow(
			'not a figure'
		);
	});
});
