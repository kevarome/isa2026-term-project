CREATE TABLE api_requests (
  id INTEGER PRIMARY KEY,
  user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  method TEXT NOT NULL,
  route TEXT NOT NULL,
  status_code INTEGER NOT NULL CHECK (status_code BETWEEN 100 AND 599),
  duration_ms INTEGER CHECK (duration_ms >= 0),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX api_requests_by_time ON api_requests(created_at);

-- Prior versions recorded completed ticket submissions only. Their latency is unknown.
INSERT INTO api_requests (user_id, method, route, status_code, created_at)
SELECT user_id, 'POST', '/api/tickets', 201, created_at
FROM api_usage
WHERE endpoint = 'POST /api/tickets';
