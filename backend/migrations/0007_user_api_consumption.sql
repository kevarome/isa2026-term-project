-- Keep old and new requests under the same endpoint when the API version changes.
UPDATE api_requests
SET route = '/api/v1' || substr(route, 5)
WHERE route LIKE '/api/%' AND route NOT LIKE '/api/v1/%';

CREATE TABLE user_api_consumption (
  user_id TEXT PRIMARY KEY NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  total INTEGER NOT NULL CHECK (total >= 0)
);

-- Migration 0005 already imported the early ticket submissions into api_requests.
-- Anonymous events and authentication lifecycle requests do not use the allowance.
INSERT INTO user_api_consumption (user_id, total)
SELECT user_id, COUNT(*) FROM api_requests
WHERE user_id IS NOT NULL AND route IN (
  '/api/v1/auth/me', '/api/v1/tickets', '/api/v1/tickets/:id', '/api/v1/stats',
  '/api/v1/admin/tickets', '/api/v1/admin/tickets/:id', '/api/v1/admin/usage',
  '/api/v1/admin/users', '/api/v1/admin/users/:id'
)
GROUP BY user_id;
