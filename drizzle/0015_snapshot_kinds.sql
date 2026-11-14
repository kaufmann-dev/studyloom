-- Saved source snapshots gain what new ones carry: a kind per chunk and the source's figures.
UPDATE "outputs" SET "source_snapshot" = (
	SELECT COALESCE(jsonb_agg(
		m.value || jsonb_build_object(
			'figures', COALESCE(m.value->'figures', '[]'::jsonb),
			'chunks', (
				SELECT COALESCE(jsonb_agg('{"kind":"text"}'::jsonb || c.value ORDER BY c.n), '[]'::jsonb)
				FROM jsonb_array_elements(m.value->'chunks') WITH ORDINALITY AS c(value, n)
			)
		) ORDER BY m.n), '[]'::jsonb)
	FROM jsonb_array_elements("source_snapshot") WITH ORDINALITY AS m(value, n)
)
WHERE jsonb_typeof("source_snapshot") = 'array';
--> statement-breakpoint
UPDATE "jobs" SET "payload" = jsonb_set("payload", '{snapshot}', (
	SELECT COALESCE(jsonb_agg(
		m.value || jsonb_build_object(
			'figures', COALESCE(m.value->'figures', '[]'::jsonb),
			'chunks', (
				SELECT COALESCE(jsonb_agg('{"kind":"text"}'::jsonb || c.value ORDER BY c.n), '[]'::jsonb)
				FROM jsonb_array_elements(m.value->'chunks') WITH ORDINALITY AS c(value, n)
			)
		) ORDER BY m.n), '[]'::jsonb)
	FROM jsonb_array_elements("payload"->'snapshot') WITH ORDINALITY AS m(value, n)
))
WHERE jsonb_typeof("payload"->'snapshot') = 'array';
