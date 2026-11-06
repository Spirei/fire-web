"""Shared account insertion for public registration and the explicit administrator CLI."""

from uuid import uuid4

from .db import TargetMismatch


class LoginConflict(ValueError):
    pass


async def registration_status(conn):
    row = await (
        await conn.execute(
            "SELECT NOT bootstrap_completed AND NOT EXISTS (SELECT 1 FROM users) AS first_user "
            "FROM registration_state WHERE singleton=true"
        )
    ).fetchone()
    if not row:
        raise TargetMismatch("Registration state is missing")
    return row


async def insert_account(
    conn, username: str, password_hash: str, *, role: str | None = None, email="", is_test: bool = False
):
    # Matches the CLI lock. All first-user decisions and both unique login namespaces serialize.
    # Caller owns the transaction so user, claim, session and audit either all commit or all roll back.
    await conn.execute("LOCK TABLE users IN SHARE ROW EXCLUSIVE MODE")
    if role is None:
        from .site_registration import require_registration_open

        await require_registration_open(conn)
    first = (await registration_status(conn))["first_user"]
    for login in (username, email):
        if (
            login
            and await (
                await conn.execute(
                    "SELECT id FROM users WHERE lower(username)=lower(%s) OR (email<>'' AND lower(email)=lower(%s))",
                    (login, login),
                )
            ).fetchone()
        ):
            raise LoginConflict("Login identifier is already used")
    chosen_role = role if role is not None else ("admin" if first else "user")
    user = await (
        await conn.execute(
            "INSERT INTO users (id,username,email,password_hash,role,is_test) VALUES (%s,%s,%s,%s,%s,%s) "
            "RETURNING id,username,role,session_version",
            ("u-" + uuid4().hex, username, email, password_hash, chosen_role, is_test),
        )
    ).fetchone()
    await conn.execute(
        "UPDATE registration_state SET bootstrap_completed=true, "
        "first_admin_user_id=CASE WHEN NOT bootstrap_completed AND %s='admin' THEN %s ELSE first_admin_user_id END, "
        "claimed_at=CASE WHEN NOT bootstrap_completed THEN clock_timestamp() ELSE claimed_at END "
        "WHERE singleton=true",
        (chosen_role, user["id"]),
    )
    await conn.execute(
        "INSERT INTO audit_events (actor_id,action,target_id) VALUES (%s,'user.created',%s)",
        (user["id"], user["id"]),
    )
    return user
