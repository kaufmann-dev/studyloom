-- Audio summaries now record a style and one voice per speaker.
UPDATE "outputs"
SET "audio" = jsonb_build_object(
	'style', 'narration',
	'voices', jsonb_build_array(jsonb_build_object(
		'speaker', 'narrator',
		'voiceId', "audio"->>'voiceId',
		'voiceName', "audio"->>'voiceName'
	)),
	'speechModelId', "audio"->'speechModelId',
	'speechModelName', "audio"->'speechModelName',
	'durationMs', "audio"->'durationMs',
	'characters', "audio"->'characters'
)
WHERE "audio" ? 'voiceId';
