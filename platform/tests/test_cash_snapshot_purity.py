from contextlib import asynccontextmanager
from types import SimpleNamespace

import pytest
from alcor_api import scope_coverage
from alcor_api.cash_ledger import CashLedger


class ReadOnlyConnection:
    def __init__(self, initialized):
        self.initialized, self.statements = initialized, []
        self.row, self.rows = None, []

    @asynccontextmanager
    async def transaction(self):
        yield

    async def execute(self, sql, args=None):
        self.statements.append((sql, args))
        assert sql.lstrip().split()[0] in {"SELECT", "SET"}, sql
        self.row, self.rows = None, []
        if "FROM sessions" in sql:
            self.row = {"id": "owner"}
        elif "SELECT active,role FROM users" in sql:
            self.row = {"active": True, "role": "user"}
        elif "FROM broker_accounts WHERE" in sql:
            self.row = {"id": "account", "deleted_at": None, "account_kind": "real", "holding_source": "manual", "currencies": ["USD"]}
        elif "FROM cash_ledger_accounts" in sql and self.initialized:
            self.row = {"opening_at": "explicit-checkpoint", "opening_basis": "new_external_opening"}
        return self

    async def fetchone(self):
        return self.row

    async def fetchall(self):
        return self.rows


@pytest.mark.parametrize("initialized,known,expected", [(False, False, None), (True, False, None), (True, True, "0")])
async def test_snapshot_never_initializes_financial_state_and_unknown_is_not_zero(monkeypatch, initialized, known, expected):
    conn = ReadOnlyConnection(initialized)
    @asynccontextmanager
    async def connection():
        yield conn
    service = CashLedger(SimpleNamespace(connection=connection))
    async def complete(*_args):
        return known
    monkeypatch.setattr(scope_coverage, "account_status", complete)
    monkeypatch.setattr(scope_coverage, "scope_status", complete)
    monkeypatch.setattr(service, "actual_known", complete)
    who = SimpleNamespace(id="owner", role="user", token_hash="current-session")
    result = await service.snapshot(who, "account")
    assert result["revision"] == 0
    currency = result["currencies"][0]
    assert currency["balance"] == expected
    assert currency["registeredBalance"] == ("0" if initialized else None)
    assert currency["complete"] is bool(initialized and known)
    assert any("FOR SHARE OF u,s" in sql for sql, _ in conn.statements)
    assert any("FROM cash_ledger_collections" in sql for sql, _ in conn.statements)
