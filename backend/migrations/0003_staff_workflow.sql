CREATE TABLE staff_profiles (
  user_id TEXT PRIMARY KEY NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  department TEXT NOT NULL CHECK (department IN ('billing', 'technical', 'account', 'general'))
);

CREATE TABLE tickets_workflow (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  message TEXT NOT NULL,
  department TEXT CHECK (department IN ('billing', 'technical', 'account', 'general')),
  urgency TEXT CHECK (urgency IN ('low', 'medium', 'high')),
  confidence REAL CHECK (confidence BETWEEN 0 AND 1),
  status TEXT NOT NULL CHECK (status IN ('manual_review', 'open', 'in_progress', 'resolved', 'closed')),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  classification_outcome TEXT,
  suggested_department TEXT CHECK (suggested_department IN ('billing', 'technical', 'account', 'general')),
  suggested_urgency TEXT CHECK (suggested_urgency IN ('low', 'medium', 'high')),
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1)
);

INSERT INTO tickets_workflow (
  id, user_id, message, department, urgency, confidence, status, created_at,
  classification_outcome, suggested_department, suggested_urgency, updated_at
)
SELECT id, user_id, message, department, urgency, confidence, status, created_at,
       classification_outcome,
       COALESCE(suggested_department, CASE WHEN classification_outcome = 'classified' THEN department END),
       COALESCE(suggested_urgency, CASE WHEN classification_outcome = 'classified' THEN urgency END),
       created_at
FROM tickets;

DROP TABLE tickets;
ALTER TABLE tickets_workflow RENAME TO tickets;

CREATE INDEX tickets_by_user ON tickets(user_id, created_at DESC, id DESC);
CREATE INDEX tickets_by_creation ON tickets(created_at DESC, id DESC);
CREATE INDEX tickets_by_department ON tickets(department, created_at DESC, id DESC);
