-- Watch-group preferences are not financial records or broker account identities.
CREATE TABLE watch_group_collections (
    owner_id text PRIMARY KEY REFERENCES users(id),
    revision bigint NOT NULL DEFAULT 0 CHECK (revision >= 0)
);
CREATE TABLE watch_groups (
    owner_id text NOT NULL REFERENCES users(id),
    id text NOT NULL,
    name text NOT NULL CHECK (length(name) BETWEEN 1 AND 30),
    name_key text NOT NULL,
    icon text NOT NULL DEFAULT '',
    sort integer NOT NULL CHECK (sort >= 0),
    visible smallint NOT NULL DEFAULT -1 CHECK (visible IN (-1,0,1)),
    kind text NOT NULL CHECK (kind IN ('market','custom')),
    market text NOT NULL DEFAULT '',
    revision bigint NOT NULL CHECK (revision > 0),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    deleted_at timestamptz,
    PRIMARY KEY (owner_id,id),
    CHECK ((kind='custom' AND market='') OR (kind='market' AND market IN ('US','HK','CN','SG','JP','KR'))),
    CHECK (kind <> 'market' OR deleted_at IS NULL)
);
CREATE UNIQUE INDEX watch_groups_market ON watch_groups(owner_id,market) WHERE kind='market';
CREATE UNIQUE INDEX watch_groups_name ON watch_groups(owner_id,name_key) WHERE deleted_at IS NULL;
CREATE INDEX watch_groups_changes ON watch_groups(owner_id,revision);
CREATE TABLE watch_group_operations (
    owner_id text NOT NULL REFERENCES users(id),
    request_id uuid NOT NULL,
    fingerprint text NOT NULL,
    result jsonb NOT NULL,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (owner_id,request_id)
);
