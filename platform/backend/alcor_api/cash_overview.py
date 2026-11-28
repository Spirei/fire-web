"""Read-only owner/kind cash books; provider observations never create global funds."""

from collections import defaultdict
from decimal import Decimal, localcontext

from fastapi import HTTPException
from fastapi.encoders import jsonable_encoder

from .broker_metadata import BrokerMetadata, fingerprint
from .cash_ledger import CashLedger, book_reservations, cash_balance_totals
from .scope_coverage import scope_status


class CashOverview(BrokerMetadata):
    def __init__(self, db):
        super().__init__(db)
        self.cash = CashLedger(db)

    async def state(self, who):
        async with self.context(who,shared_read=True) as conn:
            return await self.on_connection(conn, who)

    async def on_connection(self, conn, who, *, include_availability=True):
        # No collection rows, openings or zero-balance accounts are initialized by reads.
        # The caller provides a stable view through the owner lock or MVCC.
        accounts = await (await conn.execute(
            "SELECT id,account_kind,currencies,revision,name,holding_source FROM broker_accounts "
            "WHERE owner_id=%s AND deleted_at IS NULL ORDER BY created_at,id LIMIT 101",
            (who.id,),
        )).fetchall()
        if len(accounts) > 100:
            raise HTTPException(409, "账户目录超过完整现金读取上限")
        head = await (await conn.execute(
            "SELECT revision FROM cash_ledger_collections WHERE owner_id=%s", (who.id,),
        )).fetchone()
        revision = head['revision'] if head else 0
        postings = await (await conn.execute(
            """SELECT account_kind,currency,account_id,affects_owner,sum(amount) AS amount,
                      bool_or(kind='opening' AND affects_owner) AS opening_known,
                      max(occurred_at) AS ledger_as_of
               FROM cash_ledger_entries WHERE owner_id=%s
               GROUP BY account_kind,currency,account_id,affects_owner""", (who.id,),
        )).fetchall()
        by_scope = defaultdict(list)
        for row in postings:
            by_scope[row['account_kind'], row['currency']].append(row)
        balances = {key: cash_balance_totals(rows) for key, rows in by_scope.items()}
        currencies = {'real': set(), 'simulated': set()}
        snapshots = []
        scope_proofs = {}
        scope_reservations = {}
        for account in accounts:
            evidence = {}
            if account['account_kind'] in currencies:
                snapshot = await self.cash.snapshot_on_connection(
                    conn, who, account['id'], revision, account=account, evidence=evidence,
                    scope_balances=balances, scope_proofs=scope_proofs,
                )
            else:
                snapshot = {'accountId': account['id'], 'revision': revision,
                            'currencies': [{'currency': currency, 'registeredBalance': None, 'balance': None,
                                            'complete': False, 'ownerCashComplete': False, 'opening': None}
                                           for currency in account['currencies']],
                            'blockedReason': 'account_kind_unverified'}
            capacities = {}
            if account['account_kind'] in currencies:
                currencies[account['account_kind']].update(account['currencies'])
                currencies[account['account_kind']].update(row['currency'] for row in snapshot['currencies'])
                if include_availability:
                    for currency in account['currencies']:
                        capacities[currency] = await self.cash.withdrawal_capacity_on_connection(
                            conn, who, account['id'], currency, account_kind=account['account_kind'],
                            account=account, evidence=evidence.get(currency), scope_reservations=scope_reservations,
                        )
            snapshots.append({'accountId': account['id'], 'accountRevision': account['revision'],
                              'name': account['name'], 'accountKind': account['account_kind'],
                              'holdingSource': account['holding_source'], 'snapshot': snapshot,
                              'ledgerWithdrawalCapacities': capacities})
        for kind, currency in by_scope:
            if kind not in currencies:
                raise HTTPException(503, "资金流水的真实或模拟账本归属尚未核对")
            currencies[kind].add(currency)
        books = []
        for kind, values in currencies.items():
            rows = []
            for currency in sorted(values):
                key = kind, currency
                postings = by_scope.get(key, ())
                opened = any(row['opening_known'] for row in postings)
                proof = scope_proofs.get(key)
                if proof is None:
                    scope_complete = (
                        await scope_status(conn, who.id, kind, currency)
                        and await self.cash.actual_known(conn, who.id, kind, currency)
                    )
                else:
                    scope_complete = all(proof)
                complete = opened and scope_complete
                reservation = (await book_reservations(conn, who.id, kind, currency, scope_reservations)
                               if include_availability else None)
                reservations_known = reservation is not None and reservation['complete'] and reservation['cash'] is not None
                total, allocated, _ = balances.get(key, (Decimal(0), Decimal(0), {}))
                with localcontext() as decimal_context:
                    decimal_context.prec = 80
                    unallocated = total - allocated
                    available = max(Decimal(0), total - reservation['cash']) if complete and reservations_known else None
                rows.append({
                    'currency': currency, 'openingKnown': opened, 'complete': bool(complete),
                    'ownerBalance': str(total) if complete else None,
                    'registeredOwnerBalance': str(total) if opened else None,
                    'registeredAttributedBalance': str(allocated) if opened else None,
                    'unallocatedBalance': str(unallocated) if complete else None,
                    'registeredUnallocatedBalance': str(unallocated) if opened else None,
                    'reservedBuyCash': str(reservation['cash']) if reservations_known else None,
                    'reservationsComplete': bool(reservations_known),
                    'availableOwnerBalance': str(available) if available is not None else None,
                    'ledgerAsOf': max(row['ledger_as_of'] for row in postings).isoformat() if postings else None,
                    'authority': 'platform_posted_cash_ledger',
                    'externalBuyingPowerKnown': False,
                })
            books.append({'accountKind': kind, 'currencies': rows})
        value = {
            'revision': revision, 'books': books, 'accounts': snapshots,
            'coverageScope': 'platform_owner_kind_original_currency',
            'historicalCoverageKnown': False, 'officialSnapshotsAddedToOwnerBalance': False,
            'unboundLegacyGlobalCashIncluded': False,
        }
        value['snapshotRevision'] = fingerprint(jsonable_encoder(value, custom_encoder={Decimal: str}))
        return value
