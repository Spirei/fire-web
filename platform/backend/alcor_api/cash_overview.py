"""Read-only owner/kind cash books; provider observations never create global funds."""

from decimal import Decimal, localcontext

from fastapi import HTTPException
from fastapi.encoders import jsonable_encoder

from .broker_accounts import broker_account
from .broker_metadata import BrokerMetadata, fingerprint
from .cash_ledger import CashLedger
from .internal_orders import pending_reservations
from .scope_coverage import scope_status


class CashOverview(BrokerMetadata):
    def __init__(self, db):
        super().__init__(db)
        self.cash = CashLedger(db)

    async def state(self, who):
        async with self.context(who) as conn:
            return await self.on_connection(conn, who)

    async def on_connection(self, conn, who):
        # No collection rows, openings or zero-balance accounts are initialized by reads.
        accounts = await (await conn.execute(
            "SELECT id FROM broker_accounts WHERE owner_id=%s AND deleted_at IS NULL ORDER BY created_at,id LIMIT 101",
            (who.id,),
        )).fetchall()
        if len(accounts) > 100:
            raise HTTPException(409, "账户目录超过完整现金读取上限")
        head = await (await conn.execute(
            "SELECT revision FROM cash_ledger_collections WHERE owner_id=%s", (who.id,),
        )).fetchone()
        revision = head['revision'] if head else 0
        postings = await (await conn.execute(
            "SELECT account_kind,currency,bool_or(kind='opening' AND affects_owner) AS opening_known,"
            "max(occurred_at) AS ledger_as_of FROM cash_ledger_entries WHERE owner_id=%s "
            "GROUP BY account_kind,currency ORDER BY account_kind,currency", (who.id,),
        )).fetchall()
        by_scope = {(row['account_kind'], row['currency']): row for row in postings}
        currencies = {'real': set(), 'simulated': set()}
        snapshots = []
        for selected in accounts:
            account = await broker_account(conn, who.id, selected['id'])
            if account['account_kind'] in currencies:
                snapshot = await self.cash.snapshot_on_connection(conn, who, account['id'], revision)
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
                for currency in account['currencies']:
                    capacities[currency] = await self.cash.withdrawal_capacity_on_connection(
                        conn, who, account['id'], currency, account_kind=account['account_kind'],
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
                evidence = by_scope.get((kind, currency))
                opened = bool(evidence and evidence['opening_known'])
                complete = opened and await scope_status(conn, who.id, kind, currency) and await self.cash.actual_known(
                    conn, who.id, kind, currency,
                )
                reservation = await pending_reservations(conn, who.id, kind, currency)
                reservations_known = reservation['complete'] and reservation['cash'] is not None
                total, allocated, _ = await self.cash.balances(conn, who.id, currency, None, kind)
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
                    'ledgerAsOf': evidence['ledger_as_of'].isoformat() if evidence else None,
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
