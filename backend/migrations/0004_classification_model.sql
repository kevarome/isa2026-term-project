ALTER TABLE tickets ADD COLUMN classification_model TEXT;

UPDATE tickets
SET classification_model = 'typesafe/jev'
WHERE classification_outcome IN ('classified', 'low_confidence');
