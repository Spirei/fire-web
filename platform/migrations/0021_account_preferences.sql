CREATE TABLE account_preferences (
    user_id text PRIMARY KEY REFERENCES users(id),
    appearance jsonb CHECK(appearance IS NULL OR jsonb_typeof(appearance)='object'),
    avatar_status text NOT NULL DEFAULT 'online' CHECK(avatar_status IN ('online','focus','doNotDisturb')),
    revision uuid NOT NULL DEFAULT gen_random_uuid(),
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
