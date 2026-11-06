"""Pure capability/receipt boundaries; no PostgreSQL or provider fixtures."""

import secrets
from datetime import UTC, datetime, timedelta
from uuid import uuid4

import pytest
from alcor_api.account_closure import ReceiptCapability, capability_hash, receipt_projection
from fastapi import HTTPException
from pydantic import ValidationError


def test_read_capability_is_instance_and_purpose_bound_and_secret_in_model_repr():
    token = "acr_" + secrets.token_urlsafe(32)
    model = ReceiptCapability(receipt_token=token)
    assert token not in str(model) and token not in repr(model)
    assert capability_hash(uuid4(), token) != capability_hash(uuid4(), token)
    instance = uuid4()
    assert capability_hash(instance, token) == capability_hash(instance, token)
    assert capability_hash(instance, token) != capability_hash(instance, token + "x")
    for bad in ("Bearer " + token, token + "x", token[:-1], "fat_" + "A" * 43):
        with pytest.raises(ValidationError):
            ReceiptCapability(receipt_token=bad)


@pytest.mark.parametrize("state", ["completed", "closed"])
async def test_post_logout_receipt_is_minimal_and_omits_private_snapshot(state):
    identifier = uuid4()
    result = (
        {"request_id": str(identifier), "closed": True, "executed": False}
        if state == "closed"
        else {
            "request_id": str(identifier),
            "user_id": "synthetic-owner",
            "deleted": True,
            "privateFutureSnapshot": "SyntheticNeverExpose9",
        }
    )

    class Result:
        async def fetchone(self):
            return {"result": result, "closed": state == "closed"}

    class Connection:
        async def execute(self, query, args):
            assert query.startswith("SELECT ") and args == ("synthetic-owner", identifier)
            return Result()

    value = await receipt_projection(
        Connection(), {"request_id": identifier, "owner_id": "synthetic-owner", "state": state}
    )
    assert value["state"] == state and value["request_id"] == str(identifier)
    assert "synthetic-owner" not in str(value) and "SyntheticNeverExpose9" not in str(value)
    assert set(value) == {"request_id", "scope", "state"} | (
        {"closed", "executed"} if state == "closed" else {"deleted"}
    )


async def test_prepared_is_not_a_false_terminal_or_nonexecution_receipt():
    now = datetime.now(UTC)
    value = await receipt_projection(
        None,
        {
            "request_id": uuid4(),
            "revision": uuid4(),
            "state": "prepared",
            "prepared_until": now + timedelta(minutes=10),
            "expires_at": now + timedelta(days=30),
        },
    )
    assert value["state"] == "prepared" and "executed" not in value and "deleted" not in value


async def test_missing_restored_original_proof_fails_closed():
    class Result:
        async def fetchone(self):
            return None

    class Connection:
        async def execute(self, query, args):
            return Result()

    with pytest.raises(HTTPException) as error:
        await receipt_projection(
            Connection(), {"request_id": uuid4(), "owner_id": "missing-original", "state": "completed"}
        )
    assert error.value.status_code == 503
