-- Quizzes move to questions made of answer fields. A multiple-choice question becomes one radio
-- field named "answer", a written question one essay field. Attempts are converted first, while
-- the quiz they belong to still has its old shape to read option positions from.
UPDATE "attempts" AS a SET "answers" = (
	SELECT COALESCE(jsonb_agg(jsonb_build_object(
		'questionId', ans.value->'questionId',
		'values', jsonb_build_object('answer',
			CASE WHEN q.value->>'type' = 'multiple_choice'
				THEN COALESCE((
					SELECT 'o' || opt.n
					FROM jsonb_array_elements_text(q.value->'options') WITH ORDINALITY AS opt(text, n)
					WHERE opt.text = ans.value->>'value' LIMIT 1), '')
				ELSE COALESCE(ans.value->>'value', '') END)
	) ORDER BY ans.n), '[]'::jsonb)
	FROM jsonb_array_elements(a."answers") WITH ORDINALITY AS ans(value, n)
	JOIN "outputs" AS o ON o."id" = a."output_id"
	LEFT JOIN LATERAL (
		SELECT question.value FROM jsonb_array_elements(o."quiz"->'questions') AS question(value)
		WHERE question.value->>'id' = ans.value->>'questionId' LIMIT 1
	) AS q ON true
)
WHERE EXISTS (
	SELECT 1 FROM "outputs" AS o
	WHERE o."id" = a."output_id" AND jsonb_path_exists(o."quiz", '$.questions[*].question')
);
--> statement-breakpoint
-- A written answer still waiting for its grade keeps waiting as a pending field.
UPDATE "attempts" AS a SET "grades" = (
	SELECT COALESCE(jsonb_agg(s.entry ORDER BY s.n) FILTER (WHERE s.entry IS NOT NULL), '[]'::jsonb)
	FROM (
		SELECT q.n, CASE
			WHEN g.value IS NOT NULL THEN jsonb_build_object(
				'questionId', q.value->'id',
				'score', g.value->'score',
				'maxScore', g.value->'maxScore',
				'state', CASE WHEN (g.value->>'score')::numeric >= (g.value->>'maxScore')::numeric
					THEN 'correct' ELSE 'incorrect' END,
				'fields', jsonb_build_array(jsonb_build_object(
					'fieldId', 'answer',
					'state', CASE WHEN (g.value->>'score')::numeric >= (g.value->>'maxScore')::numeric
						THEN 'correct' ELSE 'incorrect' END,
					'score', g.value->'score',
					'max', g.value->'maxScore',
					'expected', COALESCE(g.value->'correctAnswer', q.value->'correctAnswer')
				) || CASE WHEN q.value->>'type' = 'written'
					THEN jsonb_build_object('feedback', g.value->'feedback') ELSE '{}'::jsonb END))
			WHEN q.value->>'type' = 'written' AND a."status" = 'grading' THEN jsonb_build_object(
				'questionId', q.value->'id',
				'score', 0,
				'maxScore', 1,
				'state', 'pending',
				'fields', jsonb_build_array(jsonb_build_object(
					'fieldId', 'answer', 'state', 'pending', 'score', 0, 'max', 1,
					'expected', q.value->'correctAnswer')))
			END AS entry
		FROM "outputs" AS o
		CROSS JOIN LATERAL jsonb_array_elements(o."quiz"->'questions') WITH ORDINALITY AS q(value, n)
		LEFT JOIN LATERAL (
			SELECT grade.value FROM jsonb_array_elements(a."grades") AS grade(value)
			WHERE grade.value->>'questionId' = q.value->>'id' LIMIT 1
		) AS g ON true
		WHERE o."id" = a."output_id"
	) AS s
)
WHERE EXISTS (
	SELECT 1 FROM "outputs" AS o
	WHERE o."id" = a."output_id" AND jsonb_path_exists(o."quiz", '$.questions[*].question')
);
--> statement-breakpoint
UPDATE "outputs" AS o SET "quiz" = jsonb_build_object(
	'title', o."quiz"->'title',
	'images', '[]'::jsonb,
	'parts', jsonb_build_array(jsonb_build_object(
		'id', 'p01',
		'title', o."quiz"->'title',
		'questions', (
			SELECT jsonb_agg(jsonb_build_object(
				'id', q.value->'id',
				'body', (q.value->>'question') || E'\n\n{{answer}}',
				'fields', jsonb_build_array(
					CASE WHEN q.value->>'type' = 'multiple_choice' THEN jsonb_build_object(
						'id', 'answer', 'type', 'select', 'display', 'radio', 'points', 1,
						'options', (
							SELECT jsonb_agg(jsonb_build_object('id', 'o' || opt.n, 'text', opt.text) ORDER BY opt.n)
							FROM jsonb_array_elements_text(q.value->'options') WITH ORDINALITY AS opt(text, n)),
						'correct', COALESCE((
							SELECT 'o' || opt.n
							FROM jsonb_array_elements_text(q.value->'options') WITH ORDINALITY AS opt(text, n)
							WHERE opt.text = q.value->>'correctAnswer' LIMIT 1), 'o1'))
					ELSE jsonb_build_object(
						'id', 'answer', 'type', 'essay', 'points', 1,
						'modelAnswer', q.value->'correctAnswer',
						'rubric', COALESCE(q.value->'rubric', '""'::jsonb)) END),
				'explanation', COALESCE(q.value->'explanation', '""'::jsonb),
				'feedback', jsonb_build_object(
					'correct', left(COALESCE(q.value->>'explanation', ''), 600),
					'incorrect', left(COALESCE(q.value->>'explanation', ''), 600)),
				'citations', q.value->'citations'
			) ORDER BY q.n)
			FROM jsonb_array_elements(o."quiz"->'questions') WITH ORDINALITY AS q(value, n))))
)
WHERE o."quiz" IS NOT NULL AND jsonb_path_exists(o."quiz", '$.questions[*].question');
--> statement-breakpoint
-- Jobs that may still run or be retried ask for a coverage instead of a length or a count.
UPDATE "jobs" SET "payload" =
	("payload" - 'audioLength' - 'sessionLength' - 'questionCount' - 'questionMix')
	|| '{"coverage":"standard","questionStyles":["choice","embedded","written"]}'::jsonb
WHERE "kind" IN ('quiz', 'audio', 'session')
	AND "status" <> 'succeeded'
	AND NOT jsonb_exists("payload", 'coverage');
