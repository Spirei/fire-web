-- This marker is durable: disabling/removing users must never reopen first-admin signup.
CREATE TABLE registration_state (
    singleton boolean PRIMARY KEY CHECK (singleton = true),
    bootstrap_completed boolean NOT NULL,
    first_admin_user_id text,
    claimed_at timestamptz
);
INSERT INTO registration_state (singleton, bootstrap_completed)
SELECT true, EXISTS (SELECT 1 FROM users);
