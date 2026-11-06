"""Explicit cash postings. No source balance is inferred from holdings or prices."""

import hashlib
import json
import secrets
from datetime import UTC, datetime
from decimal import Decimal, localcontext
from uuid import UUID, uuid4

from fastapi import HTTPException
from psycopg.types.json import Jsonb

from .broker_accounts import broker_account, broker_connection, serialize_brokers
from .security import digest, lock_mutation_identity
from .trade_accounting import MAX_VALUE, AccountingError, number


def add(a, b):
    with localcontext() as context:
        context.prec = 80
        return a + b


def fingerprint(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


def normalize(data):
    fields = {
        "requestId",
        "accountId",
        "currency",
        "action",
        "amount",
        "occurredAt",
        "note",
        "openingBasis",
        "accountKind",
        "allowNegativeBalance",
        "financingConfirmation",
        "evidence",
    }
    if not isinstance(data, dict) or set(data) - fields:
        raise HTTPException(422, "现金参数无效")
    if 'allowNegativeBalance' in data or 'financingConfirmation' in data:
        from .financing_model import confirmation
        if data.get('allowNegativeBalance') is not True or data.get('action')!='reconcile_balance':raise HTTPException(422,'负余额确认仅用于本人核实的实际余额修正')
        confirmation(data.get('financingConfirmation'))
    try:
        if not isinstance(data.get("requestId"), str) or not isinstance(data.get("occurredAt"), str):
            raise TypeError()
        request_id = str(UUID(data["requestId"]))
        amount = number(data["amount"], negative=True)
        if amount.as_tuple().exponent < -18 or amount.copy_abs() > MAX_VALUE:
            raise ValueError()
        when = datetime.fromisoformat(data["occurredAt"])
        if when.tzinfo is None:
            raise ValueError()
        currency = data["currency"]
        if (
            not isinstance(currency, str)
            or len(currency) != 3
            or not currency.isascii()
            or not currency.isalpha()
            or currency != currency.upper()
        ):
            raise ValueError()
        account_kind = data["accountKind"]
        if account_kind not in {"real", "simulated"}:
            raise ValueError()
        account = data.get("accountId")
        if account is not None and (not isinstance(account, str) or len(account) > 100 or not account):
            raise ValueError()
        action = data["action"]
        if action not in {"opening", "external_deposit", "external_withdrawal", "reconcile_balance"}:
            raise ValueError()
        note = data.get("note", "")
        if not isinstance(note, str) or len(note) > 500 or "\x00" in note:
            raise ValueError()
        basis = data.get("openingBasis")
        if action == "opening":
            if (
                basis not in {"new_external_opening", "allocate_verified_unallocated_checkpoint"}
                or amount < 0
            ):
                raise ValueError()
        elif basis is not None or amount < 0 and not (action=="reconcile_balance" and data.get("allowNegativeBalance") is True):
            raise ValueError()
        if not account and (action == "opening" and basis != "new_external_opening" or data.get('allowNegativeBalance')):
            raise ValueError()
        evidence = data.get("evidence")
        if evidence is not None:
            if (action != "reconcile_balance" or not isinstance(evidence, dict) or set(evidence) != {"reference", "observedAt"}
                    or not isinstance(evidence["reference"], str) or not 1 <= len(evidence["reference"].strip()) <= 300
                    or any(ord(c) < 32 or ord(c) == 127 for c in evidence["reference"])):
                raise ValueError()
            observed = datetime.fromisoformat(evidence["observedAt"])
            if observed.tzinfo is None or observed != when:
                raise ValueError()
            evidence = {"reference": evidence["reference"].strip(), "observedAt": observed.astimezone(UTC).isoformat()}
    except (KeyError, TypeError, ValueError, AccountingError):
        raise HTTPException(422, "现金参数无效") from None
    return {
        "requestId": request_id,
        "accountId": account,
        "accountKind": account_kind,
        "currency": currency,
        "action": action,
        "amount": str(amount),
        "occurredAt": when.astimezone(UTC).isoformat(),
        "note": note,
        "openingBasis": basis,
        **({"evidence": evidence} if evidence is not None else {}),
        **({"allowNegativeBalance":True,"financingConfirmation":data["financingConfirmation"]} if data.get("allowNegativeBalance") else {}),
    }


class CashLedger:
    def __init__(self, db):
        self.db = db

    async def lock(self, conn, who):
        await serialize_brokers(conn, who.id)
        await lock_mutation_identity(conn, who, require_admin=False)
        await conn.execute(
            "INSERT INTO cash_ledger_collections(owner_id) VALUES(%s) ON CONFLICT DO NOTHING", (who.id,)
        )
        return (
            await (
                await conn.execute(
                    "SELECT revision FROM cash_ledger_collections WHERE owner_id=%s FOR UPDATE", (who.id,)
                )
            ).fetchone()
        )["revision"]

    async def balances(self, conn, owner, currency, account, account_kind):
        rows = await (
            await conn.execute(
                "SELECT account_id,affects_owner,sum(amount) AS amount FROM cash_ledger_entries WHERE owner_id=%s AND currency=%s AND account_kind=%s GROUP BY account_id,affects_owner",
                (owner, currency, account_kind),
            )
        ).fetchall()
        with localcontext() as context:
            context.prec = 80
            total = sum((r["amount"] for r in rows if r["affects_owner"]), Decimal(0))
            attributed = sum((r["amount"] for r in rows if r["account_id"] is not None), Decimal(0))
            balance = sum((r["amount"] for r in rows if r["account_id"] == account), Decimal(0))
            return total, attributed, balance

    async def plan(self, conn, who, data, *, financial_source=False):
        account_id = data["accountId"]
        currency = data["currency"]
        amount = Decimal(data["amount"])
        when = datetime.fromisoformat(data["occurredAt"])
        now = (await (await conn.execute("SELECT clock_timestamp() AS now")).fetchone())["now"]
        if when > now:
            raise HTTPException(422, "现金记录不能使用未来时间")
        account = None
        if account_id:
            account = await broker_account(conn, who.id, account_id)
            if account["account_kind"] != data["accountKind"]:
                raise HTTPException(409, "真实与模拟账户不可混合")
            if account["holding_source"] != "manual":
                raise HTTPException(409, "官方现金不可手工修改")
            if currency not in account["currencies"]:
                raise HTTPException(409, "币种不属于该账户")
        latest = await (
            await conn.execute(
                "SELECT max(occurred_at) AS at FROM cash_ledger_entries WHERE owner_id=%s AND currency=%s AND account_kind=%s",
                (who.id, currency, data["accountKind"]),
            )
        ).fetchone()
        if latest["at"] and when < latest["at"]:
            raise HTTPException(409, "现金核对时间早于已有记录，请使用当前核对点")
        opening = (
            await (
                await conn.execute(
                    "SELECT * FROM cash_ledger_accounts WHERE owner_id=%s AND account_id=%s AND currency=%s",
                    (who.id, account_id, currency),
                )
            ).fetchone()
            if account_id
            else None
        )
        total, attributed, balance = await self.balances(
            conn, who.id, currency, account_id, data["accountKind"]
        )
        if not account_id:
            balance = add(total, attributed.copy_negate())
            opening = await (await conn.execute("SELECT occurred_at AS opening_at,'new_external_opening' AS opening_basis FROM cash_ledger_entries WHERE owner_id=%s AND account_id IS NULL AND account_kind=%s AND currency=%s AND kind='opening' ORDER BY occurred_at,id LIMIT 1", (who.id, data['accountKind'], currency))).fetchone()
        action = data["action"]
        if not financial_source and not (action=="external_deposit" or action=="opening" and data["openingBasis"]=="new_external_opening"):
            if account_id and action in ('external_withdrawal','reconcile_balance'):
                if not await self.account_complete(conn,who,data):
                    raise HTTPException(409,'本账户原币范围或历史实际费用尚未核实',headers={'X-Alcor-Financial-Scope':'incomplete'})
            else:
                from .scope_coverage import require_scope
                await require_scope(conn,who.id,data["accountKind"],currency)
                from .actual_projection import require_actual_cash
                await require_actual_cash(conn,who.id,data["accountKind"],currency)
        affects = True
        if action == "opening":
            if opening:
                raise HTTPException(409, "期初已登记")
            if (
                not account_id
                and await (
                    await conn.execute(
                        "SELECT 1 FROM cash_ledger_entries WHERE owner_id=%s AND account_id IS NULL AND currency=%s AND account_kind=%s",
                        (who.id, currency, data["accountKind"]),
                    )
                ).fetchone()
            ):
                raise HTTPException(409, "账户原币期初已登记")
            if data["openingBasis"] == "allocate_verified_unallocated_checkpoint":
                source = await (
                    await conn.execute(
                        "SELECT 1 FROM cash_ledger_entries WHERE owner_id=%s AND account_id IS NULL AND currency=%s AND account_kind=%s AND kind='opening'",
                        (who.id, currency, data["accountKind"]),
                    )
                ).fetchone()
                if not source:
                    raise HTTPException(409, "未核实原币未归属期初，不能分配")
                if amount > add(total, attributed.copy_negate()):
                    raise HTTPException(409, "未归属现金不足，不能生成新资金")
                affects = False
            delta = amount
        else:
            from .internal_orders import pending_reservations

            reservation = None
            if action in ('external_withdrawal','reconcile_balance'):
                reservation = await pending_reservations(
                    conn, who.id, data["accountKind"], currency, account_id=account_id, account_scope=bool(account_id)
                )
                if not reservation["complete"]:
                    raise HTTPException(409, "请先完成本账户委托资金预留核对")
            if not opening:
                raise HTTPException(409, "请先核对并登记现金期初")
            if when < opening["opening_at"]:
                raise HTTPException(409, "记录时间早于期初核对点")
            with localcontext() as context:
                context.prec = 80
                delta = (
                    amount - balance
                    if action == "reconcile_balance"
                    else -amount
                    if action == "external_withdrawal"
                    else amount
                )
            if action == 'reconcile_balance' and amount < reservation['account_cash'] and not (data.get('allowNegativeBalance') and reservation['account_cash']==0):
                raise HTTPException(409,'核对余额低于本账户既有预留，请先核对委托')
            # Other accounts' unknown funds/reservations never fund this account.
            if action == "external_withdrawal" and (
                amount > add(balance, reservation["account_cash"].copy_negate())
                or not account_id and amount > add(total, reservation["cash"].copy_negate())
            ):
                raise HTTPException(409, "可提款现金不足")
        return account, delta, affects, balance, total

    async def snapshot(self, who, account_id):
        from .source_read_access import source_read_lock

        async with self.db.connection() as conn, conn.transaction():
            await conn.execute("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ")
            await source_read_lock(conn, who)
            collection = await (
                await conn.execute(
                    "SELECT revision FROM cash_ledger_collections WHERE owner_id=%s", (who.id,)
                )
            ).fetchone()
            revision = collection["revision"] if collection else 0
            return await self.snapshot_on_connection(conn, who, account_id, revision)

    async def snapshot_on_connection(self, conn, who, account_id, revision):
        """Caller holds the owner/session and broker locks in one read transaction."""
        account = await broker_account(conn, who.id, account_id)
        from .scope_coverage import account_status, scope_status

        values = []
        for currency in account["currencies"]:
            opening = await (
                await conn.execute(
                    "SELECT opening_at,opening_basis FROM cash_ledger_accounts WHERE owner_id=%s AND account_id=%s AND currency=%s",
                    (who.id, account_id, currency),
                )
            ).fetchone()
            _, _, balance = await self.balances(conn, who.id, currency, account_id, account["account_kind"])
            account_complete = await account_status(conn, who.id, account_id, currency)
            actual_complete = (
                bool(opening)
                and account_complete
                and await self.actual_known(conn, who.id, account["account_kind"], currency, account_id)
            )
            values.append(
                {
                    "currency": currency,
                    "registeredBalance": str(balance) if opening else None,
                    "balance": str(balance) if actual_complete else None,
                    "complete": actual_complete,
                    "ownerCashComplete": await scope_status(conn, who.id, account["account_kind"], currency)
                    and await self.actual_known(conn, who.id, account["account_kind"], currency),
                    "opening": opening,
                }
            )
        from .broker_statement_projection import official_cash

        official = await official_cash(conn, who.id, account_id)
        if official is not None:
            by_currency = {row["currency"]: row for row in values}
            for currency in sorted(set(by_currency) | set(official["cash"])):
                row = by_currency.get(currency)
                configured = row is not None
                if row is None:
                    row = {"currency": currency, "registeredBalance": None, "opening": None}
                    values.append(row)
                reported = official["cash"].get(currency)
                row.update(
                    registeredOpening=row["opening"], opening=None,
                    balance=reported, complete=reported is not None,
                    ownerCashComplete=False, configured=configured, sourceOnly=not configured,
                    balanceAuthority="official_reported_ending_cash",
                    officialObservation=official["officialObservation"],
                    available=None, withdrawalCapacity=None,
                )
        return {"accountId": account_id, "revision": revision, "currencies": values}

    async def withdrawal_capacity_on_connection(self, conn, who, account_id, currency, *, account_kind):
        """Verified internal book limit only; caller holds the owner/source read lock.

        This does not include manual cards, local ledgers, provider buying power or
        unbound legacy/global funds. Missing opening/authority/reservations is unknown.
        """
        from .internal_orders import pending_reservations
        from .scope_coverage import account_status, scope_status

        if (
            account_kind not in ("real", "simulated")
            or not isinstance(currency, str)
            or len(currency) != 3
            or not currency.isascii()
            or not currency.isupper()
        ):
            raise HTTPException(422, "账本类型或币种尚未核对")
        account = await broker_account(conn, who.id, account_id)
        if account["account_kind"] != account_kind or currency not in account["currencies"]:
            raise HTTPException(409, "账本归属或币种已变化")
        result = {
            "amount": None,
            "reservedCash": None,
            "complete": False,
            "coverageScope": "platform_owner_kind_cash",
            "basis": "min_account_and_verified_owner_kind_cash_after_reservations",
            "accountKind": account_kind,
            "currency": currency,
        }
        opening = await (
            await conn.execute(
                "SELECT 1 FROM cash_ledger_accounts a JOIN cash_ledger_entries e ON e.owner_id=a.owner_id AND e.account_id=a.account_id AND e.currency=a.currency AND e.request_id=a.opening_request_id AND e.occurred_at=a.opening_at AND e.kind IN ('opening','allocation') WHERE a.owner_id=%s AND a.account_id=%s AND a.currency=%s AND e.account_kind=%s",
                (who.id, account_id, currency, account_kind),
            )
        ).fetchone()
        if not opening or account["holding_source"] != "manual":
            return result
        if not await account_status(conn, who.id, account_id, currency) or not await scope_status(
            conn, who.id, account_kind, currency
        ):
            return result
        if not await self.actual_known(
            conn, who.id, account_kind, currency, account_id
        ) or not await self.actual_known(conn, who.id, account_kind, currency):
            return result
        reservations = await pending_reservations(conn, who.id, account_kind, currency, account_id=account_id)
        if not reservations["complete"] or reservations["cash"] is None:
            return result
        total, _attributed, balance = await self.balances(conn, who.id, currency, account_id, account_kind)
        owner_free = add(total, reservations["cash"].copy_negate())
        return {
            **result,
            "amount": max(Decimal(0), min(balance, owner_free)),
            "reservedCash": reservations["cash"],
            "complete": True,
        }

    async def actual_known(self,conn,owner,kind,currency,account=None):
        from .actual_projection import actual_cash_known
        return await actual_cash_known(conn,owner,kind,currency,account)

    async def account_complete(self,conn,who,data):
        from .scope_coverage import account_status
        return await account_status(conn,who.id,data["accountId"],data["currency"]) and await self.actual_known(conn,who.id,data["accountKind"],data["currency"],data["accountId"])

    async def owner_complete(self,conn,who,data):
        from .scope_coverage import scope_status
        return await scope_status(conn,who.id,data["accountKind"],data["currency"]) and await self.actual_known(conn,who.id,data["accountKind"],data["currency"])

    async def preview(self, who, raw, *, connection=None):
        data = normalize(raw)
        async with broker_connection(self.db, connection) as conn, conn.transaction():
            revision = await self.lock(conn, who)
            account, delta, affects, balance, total = await self.plan(conn, who, data)
            token = secrets.token_urlsafe(32)
            proof = await (
                await conn.execute(
                    "INSERT INTO cash_ledger_previews(token_hash,owner_id,session_hash,payload_hash,revision,account_revision,expires_at) VALUES(%s,%s,%s,%s,%s,%s,clock_timestamp()+interval '600 seconds') RETURNING expires_at",
                    (
                        digest(token),
                        who.id,
                        who.token_hash,
                        fingerprint(data),
                        revision,
                        account["revision"] if account else None,
                    ),
                )
            ).fetchone()
            value={
                "preview": token,
                "expiresAt": proof["expires_at"].isoformat(),
                "accountId": data["accountId"],
                "accountKind": data["accountKind"],
                "accountName": account["name"] if account else None,
                "revision": revision,
                "delta": str(delta),
                "balanceBefore": str(balance) if data['action'] != 'opening' and (await self.account_complete(conn,who,data) if data['accountId'] else await self.owner_complete(conn,who,data)) else None,
                "registeredBalanceBefore": str(balance) if data['action'] != 'opening' else None,
                "balanceScope": "broker_account" if data['accountId'] else "unallocated_owner_kind_currency",
                "reconciliationEvidence": {"authority": "owner_declared_observation", **data.get('evidence', {'reference': 'owner-request:' + data['requestId'], 'observedAt': data['occurredAt']})} if data['action']=='reconcile_balance' else None,
                "registeredBalanceAfter": str(add(balance, delta)),
                "balanceAfter": str(add(balance, delta)) if (await self.account_complete(conn,who,data) if data['accountId'] else await self.owner_complete(conn,who,data)) else None,
                "ownerCashAfter": str(add(total, delta) if affects else total) if await self.owner_complete(conn,who,data) else None,
                "ownerCashComplete": await self.owner_complete(conn,who,data),
                "currency": data["currency"],
                "affectsOwnerCash": affects,
            }
            if data.get('allowNegativeBalance'):
                from .financing_model import effect
                value['financing']={**effect(balance,add(balance,delta)),'confirmed':True,'confirmationRequestId':data['requestId']}
            return value

    async def receipt(self, who, request_id):
        from .source_read_access import source_read_lock

        async with self.db.connection() as conn, conn.transaction():
            await source_read_lock(conn, who)
            row = await (
                await conn.execute(
                    "SELECT result FROM cash_ledger_operations WHERE owner_id=%s AND request_id=%s",
                    (who.id, request_id),
                )
            ).fetchone()
        if not row:
            raise HTTPException(404, "操作不存在")
        return {"state": "completed", **row["result"]}

    async def close(self,who,request_id,*,connection=None):
        from .source_read_access import source_read_lock

        try:identifier=str(UUID(str(request_id)))
        except (ValueError,TypeError,AttributeError):raise HTTPException(422,'请求编号无效') from None
        async with broker_connection(self.db, connection) as conn,conn.transaction():
            await source_read_lock(conn,who)
            previous=await(await conn.execute('SELECT result FROM cash_ledger_operations WHERE owner_id=%s AND request_id=%s',(who.id,identifier))).fetchone()
            if previous:return {'state':'completed',**previous['result']}
            from .asset_request_domains import require_domain
            await require_domain(conn,who.id,identifier,'cash')
            used=await(await conn.execute('SELECT 1 FROM cash_ledger_entries WHERE owner_id=%s AND request_id=%s UNION ALL SELECT 1 FROM trade_operations WHERE owner_id=%s AND request_id=%s',(who.id,identifier,who.id,identifier))).fetchone()
            if used:raise HTTPException(409,'原编号已有现金或关联操作，不能声明未执行')
            result={'requestId':identifier,'kind':'cash','state':'closed','executed':False,'financialAuthority':False}
            await conn.execute('INSERT INTO cash_ledger_operations(owner_id,request_id,fingerprint,result) VALUES(%s,%s,%s,%s)',(who.id,identifier,fingerprint({'kind':'closed','requestId':identifier}),Jsonb(result)))
            await conn.execute("INSERT INTO audit_events(actor_id,action,request_id) VALUES(%s,'cash.request.closed',%s)",(who.id,identifier))
            return result

    async def submit(self,who,raw,preview):
        if isinstance(raw,dict) and raw.get('allowNegativeBalance'):
            from .financing_failures import submit_cash
            return await submit_cash(self,who,raw,preview)
        return await self._submit_ledger(who,raw,preview)

    async def _submit_ledger(self, who, raw, preview, *, connection=None, reversal_entry_id=None, project=None):
        data = normalize(raw)
        hashed = fingerprint(data)
        if not isinstance(preview, str) or len(preview) > 128:
            raise HTTPException(422, "预览凭证无效")
        async with broker_connection(self.db, connection) as conn, conn.transaction():
            revision = await self.lock(conn, who)
            prior = await (
                await conn.execute(
                    "SELECT fingerprint,result FROM cash_ledger_operations WHERE owner_id=%s AND request_id=%s",
                    (who.id, data["requestId"]),
                )
            ).fetchone()
            if prior:
                if prior['result'].get('state') == 'closed':
                    return prior['result']
                if prior["fingerprint"] != hashed:
                    raise HTTPException(409, "请求编号已用于其他操作")
                return {"state": "completed", **prior["result"]}
            from .asset_request_domains import require_domain
            await require_domain(conn, who.id, data['requestId'], 'cash')
            if await(await conn.execute("SELECT 1 FROM trade_operations WHERE owner_id=%s AND request_id=%s AND result->>'sourcePolicyArchive'='true'",(who.id,data['requestId']))).fetchone():
                raise HTTPException(409,'原UUID已归属已归档融资政策，请查询原回执')
            if await (
                await conn.execute(
                    "SELECT 1 FROM cash_ledger_entries WHERE owner_id=%s AND request_id=%s",
                    (who.id, data["requestId"]),
                )
            ).fetchone():
                raise HTTPException(409, "请求编号已用于其他现金或成交操作")
            proof = await (
                await conn.execute(
                    "SELECT * FROM cash_ledger_previews WHERE token_hash=%s AND owner_id=%s AND session_hash=%s AND consumed_at IS NULL AND expires_at>clock_timestamp() FOR UPDATE",
                    (digest(preview), who.id, who.token_hash),
                )
            ).fetchone()
            if not proof or proof["payload_hash"] != hashed or proof["revision"] != revision:
                raise HTTPException(409, "预览已变化或过期，请重新核对")
            account, delta, affects, balance, total = await self.plan(conn, who, data)
            if proof["account_revision"] != (account["revision"] if account else None):
                raise HTTPException(409, "账户已变化，请重新核对")
            account_id = data["accountId"]
            currency = data["currency"]
            # The owner lock fixes the source head and existing actual scope;
            # this new posting and its matching completion receipt commit together.
            account_complete = bool(account_id) and await self.account_complete(conn,who,data)
            owner_complete = await self.owner_complete(conn,who,data)
            if data["action"] == "opening" and account_id:
                await conn.execute(
                    "INSERT INTO cash_ledger_accounts(owner_id,account_id,currency,opening_at,opening_basis,opening_request_id) VALUES(%s,%s,%s,%s,%s,%s)",
                    (
                        who.id,
                        account_id,
                        currency,
                        data["occurredAt"],
                        data["openingBasis"],
                        data["requestId"],
                    ),
                )
                await conn.execute(
                    "INSERT INTO broker_account_references(owner_id,account_id,kind,reference_id,currency) VALUES(%s,%s,'cash',%s,%s)",
                    (who.id, account_id, currency, currency),
                )
            entry_id = uuid4()
            if data.get('allowNegativeBalance'):
                from .financing_cash import attach
                await attach(conn,who,data,entry_id,balance,add(balance,delta))
            await conn.execute(
                "INSERT INTO cash_ledger_entries(id,owner_id,account_id,account_kind,currency,request_id,kind,amount,affects_owner,occurred_at,note,reversal_entry_id) VALUES(%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)",
                (
                    entry_id,
                    who.id,
                    account_id,
                    data["accountKind"],
                    currency,
                    data["requestId"],
                    data["action"] if affects else "allocation",
                    delta,
                    affects,
                    data["occurredAt"],
                    data["note"],
                    reversal_entry_id,
                ),
            )
            await conn.execute(
                "UPDATE cash_ledger_collections SET revision=revision+1 WHERE owner_id=%s", (who.id,)
            )
            result = {
                "state": "completed",
                "action":data['action'],
                "requestId": data["requestId"],
                "entryId": str(entry_id),
                "revision": revision + 1,
                "currency": currency,
                "delta": str(delta),
                "accountId": account_id,
                "accountKind": data['accountKind'],
                "balanceScope": "broker_account" if account_id else "unallocated_owner_kind_currency",
                "registeredBalanceAfter": str(add(balance, delta)),
                "balanceAfter": str(add(balance, delta)) if (account_complete if account_id else owner_complete) else None,
                "ownerCashAfter": str(add(total, delta) if affects else total) if owner_complete else None,
                "ownerCashComplete": owner_complete,
                "affectsOwnerCash": affects,
            }
            if data['action'] == 'reconcile_balance':
                evidence = {"authority": "owner_declared_observation", **data.get('evidence', {'reference': 'owner-request:' + data['requestId'], 'observedAt': data['occurredAt']})}
                await conn.execute('INSERT INTO cash_reconciliation_evidence(owner_id,request_id,entry_id,currency,account_kind,account_id,registered_before,target_balance,delta,evidence) VALUES(%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)', (who.id, data['requestId'], entry_id, currency, data['accountKind'], account_id, balance, data['amount'], delta, Jsonb(evidence)))
                result['reconciliationEvidence'] = evidence
                result['registeredBalanceBefore'] = str(balance)
                result['targetBalance'] = data['amount']
            if data.get('allowNegativeBalance'):
                from .financing_model import effect
                result['financing']={**effect(balance,add(balance,delta)),'confirmed':True,'confirmationRequestId':data['requestId']}
            if project is not None:
                projection = await project(conn, result)
                result['legacySnapshot'] = projection['legacySnapshot']
                result['legacyRequestHash'] = projection['legacyRequestHash']
            await conn.execute(
                "INSERT INTO cash_ledger_operations(owner_id,request_id,fingerprint,result) VALUES(%s,%s,%s,%s)",
                (who.id, data["requestId"], hashed, Jsonb(result)),
            )
            await conn.execute(
                "UPDATE cash_ledger_previews SET consumed_at=clock_timestamp() WHERE token_hash=%s",
                (digest(preview),),
            )
            await conn.execute(
                "INSERT INTO audit_events(actor_id,action,target_id,request_id) VALUES(%s,'cash.recorded',%s,%s)",
                (who.id, str(entry_id), data["requestId"]),
            )
            return result
