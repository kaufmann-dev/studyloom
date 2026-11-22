/** Moodle's German opening and closing markers. Preserve the exact activity name. */
export function availabilityMarker(title: string) {
	const match = /^(.+?) (beginnt|endet)$/u.exec(title);
	if (match) return { title: match[1], opening: match[2] === 'beginnt' };
}
export function feedbackMarker(title: string) {
	if (title.startsWith('Feedback: ')) return availabilityMarker(title);
}

interface MarkerTask {
	id: string;
	uid: string;
	title: string;
	dueDate: string;
	dueTime: string | null;
	moodleFeedbackCourse: string | null;
	moodleQuizKey: string | null;
}

/** Resolve only unique marker pairs, including past opening dates retained across syncs. */
export function availabilityPairs(rows: MarkerTask[]) {
	const groups = new Map<string, { starts: MarkerTask[]; ends: MarkerTask[] }>();
	for (const row of rows) {
		const marker = row.moodleQuizKey ? availabilityMarker(row.title) : feedbackMarker(row.title);
		if (!marker || !row.dueTime) continue;
		const key = row.moodleQuizKey
			? JSON.stringify(['quiz', row.moodleQuizKey])
			: row.moodleFeedbackCourse &&
				JSON.stringify([
					'feedback',
					row.uid.split('@').slice(1).join('@'),
					row.moodleFeedbackCourse,
					marker.title
				]);
		if (!key) continue;
		const group = groups.get(key) ?? { starts: [], ends: [] };
		(marker.opening ? group.starts : group.ends).push(row);
		groups.set(key, group);
	}
	const pairs = new Map<string, string>();
	for (const { starts, ends } of groups.values()) {
		if (starts.length !== 1 || ends.length !== 1) continue;
		const [start] = starts;
		const [end] = ends;
		if (`${start.dueDate}T${start.dueTime}` < `${end.dueDate}T${end.dueTime}`)
			pairs.set(end.id, start.id);
	}
	return pairs;
}
