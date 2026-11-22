/** Moodle's German feedback availability markers. Preserve the exact activity name. */
export function feedbackMarker(title: string) {
	const match = /^(Feedback: .+?) (beginnt|endet)$/u.exec(title);
	if (match) return { title: match[1], opening: match[2] === 'beginnt' };
}

interface MarkerTask {
	id: string;
	uid: string;
	title: string;
	dueDate: string;
	dueTime: string | null;
	moodleFeedbackCourse: string | null;
}

/** Resolve only unique marker pairs, including past opening dates retained across syncs. */
export function feedbackPairs(rows: MarkerTask[]) {
	const groups = new Map<string, { starts: MarkerTask[]; ends: MarkerTask[] }>();
	for (const row of rows) {
		const marker = feedbackMarker(row.title);
		if (!row.moodleFeedbackCourse || !marker || !row.dueTime) continue;
		const key = JSON.stringify([
			row.uid.split('@').slice(1).join('@'),
			row.moodleFeedbackCourse,
			marker.title
		]);
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
