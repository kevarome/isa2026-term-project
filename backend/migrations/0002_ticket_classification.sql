ALTER TABLE tickets ADD COLUMN classification_outcome TEXT;
ALTER TABLE tickets ADD COLUMN suggested_department TEXT
  CHECK (suggested_department IN ('billing', 'technical', 'account', 'general'));
ALTER TABLE tickets ADD COLUMN suggested_urgency TEXT
  CHECK (suggested_urgency IN ('low', 'medium', 'high'));

-- Older tickets only identify the outcome when routing succeeded or a score was saved.
UPDATE tickets SET classification_outcome = 'classified' WHERE status = 'open';
UPDATE tickets SET classification_outcome = 'low_confidence'
WHERE status = 'manual_review' AND confidence IS NOT NULL;

CREATE INDEX tickets_by_creation ON tickets(created_at DESC, id DESC);
