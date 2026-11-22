CREATE TABLE password_resets (
  token_hash TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  expires_at INTEGER NOT NULL
);

CREATE INDEX password_resets_user ON password_resets(user_id, created_at);
CREATE INDEX password_resets_expiry ON password_resets(expires_at);
CREATE INDEX sessions_user ON sessions(user_id);

CREATE TRIGGER revoke_credentials_on_password_change
AFTER UPDATE OF password_hash ON users
WHEN NEW.password_hash <> OLD.password_hash
BEGIN
  DELETE FROM sessions WHERE user_id = NEW.id;
  DELETE FROM password_resets WHERE user_id = NEW.id;
END;
