import { describe, expect, it } from 'vitest';
import { figureReferences, imageType } from './figures';

describe('figures', () => {
	it('tells the image types the browser can show by their first bytes', () => {
		expect(imageType(Buffer.from('89504e470d0a1a0a0000000d', 'hex'))).toBe('image/png');
		expect(imageType(Buffer.from('ffd8ffe000104a464946', 'hex'))).toBe('image/jpeg');
		expect(imageType(Buffer.from('RIFF\0\0\0\0WEBPVP8 '))).toBe('image/webp');
		expect(imageType(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'))).toBeUndefined();
		expect(imageType(Buffer.from('%PDF-1.7'))).toBeUndefined();
	});
	it('finds figure references and nothing else', () => {
		expect(
			figureReferences(
				'![A](figure:figures/a.png) text ![B](https://example.com/b.png) ![C](figure:figures/c.png)'
			)
		).toEqual(['figures/a.png', 'figures/c.png']);
		expect(figureReferences('figure:figures/a.png is not a reference')).toEqual([]);
	});
});
