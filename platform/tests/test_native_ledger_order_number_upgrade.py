import re
from uuid import uuid4

import psycopg
import pytest
from psycopg import sql
from psycopg.rows import dict_row
from psycopg.types.json import Jsonb

from alcor_api.cli import create_user
from alcor_api.config import ROOT, Settings
from alcor_api.migrate import migrate


@pytest.mark.asyncio
async def test_upgrade_assigns_missing_order_numbers_without_changing_receipts(pg, tmp_path):
    previous = tmp_path / 'previous-migrations'
    previous.mkdir()
    for migration in (ROOT / 'migrations').glob('[0-9]*.sql'):
        if not migration.name.startswith('0175_'):
            (previous / migration.name).symlink_to(migration)

    name = 'alcor_test_order_numbers_' + uuid4().hex
    with psycopg.connect(pg.get_uri(), autocommit=True) as server:
        server.execute(sql.SQL('CREATE DATABASE {}').format(sql.Identifier(name)))
        try:
            uri = pg.get_uri(database=name)
            settings = Settings(database_url=uri, instance_id=uuid4(), environment='test', migration_dir=previous)
            await migrate(settings, name, initialize_empty=True)
            owner = await create_user(settings, 'OrderNumbers', 'NumberMigration9Pass', email='numbers@example.invalid')
            old, new, deleted, request = (uuid4() for _ in range(4))
            purchase = {'tradeId': str(new), 'status': 'filled', 'quantity': '15', 'price': '300'}
            receipt = {'ownerId': owner, 'requestId': str(request), 'kind': 'trade', 'sourceRevision': 7}
            with psycopg.connect(uri, row_factory=dict_row) as conn:
                existing = conn.execute("SELECT nextval('trade_presentation_number')::text AS number").fetchone()['number']
                original = {
                    'orders': [
                        {'tradeId': str(old), 'status': 'pending'},
                        purchase,
                        {'tradeId': str(deleted), 'status': 'deleted', 'deletedFrom': 'filled'},
                    ],
                    'orderNumbers': {str(old): existing},
                    'orderHistory': {str(new): [{'revision': 2, 'quantity': '15', 'status': 'filled'}]},
                    'cash': [{'currency': 'USD', 'balance': '-4501.05'}],
                    'positions': [{'recordId': 'synthetic-record', 'quantity': '33'}],
                }
                conn.execute('INSERT INTO native_ledger_heads(owner_id,revision,snapshot) VALUES(%s,7,%s)',
                             (owner, Jsonb(original)))
                conn.execute('''
                    INSERT INTO native_ledger_transactions (owner_id,request_id,revision,fingerprint,event,receipt)
                    VALUES (%s,%s,7,%s,%s,%s)
                ''', (owner, request, '2' * 64, Jsonb({'kind': 'trade', 'orders': [purchase]}), Jsonb(receipt)))
                before = conn.execute('SELECT * FROM native_ledger_heads WHERE owner_id=%s', (owner,)).fetchone()
                transaction = conn.execute('SELECT * FROM native_ledger_transactions WHERE owner_id=%s', (owner,)).fetchone()

            settings.migration_dir = ROOT / 'migrations'
            await migrate(settings, name)
            with psycopg.connect(uri, row_factory=dict_row) as conn:
                repaired = conn.execute('SELECT * FROM native_ledger_heads WHERE owner_id=%s', (owner,)).fetchone()
                numbers = repaired['snapshot']['orderNumbers']
                assert set(numbers) == {str(old), str(new), str(deleted)}
                assert numbers[str(old)] == existing
                assert len(set(numbers.values())) == 3
                assert all(re.fullmatch(r'[0-9]{10}', number) for number in numbers.values())
                assert repaired == {**before, 'snapshot': {**original, 'orderNumbers': numbers}}
                assert conn.execute('SELECT * FROM native_ledger_transactions WHERE owner_id=%s',
                                    (owner,)).fetchall() == [transaction]

            await migrate(settings, name)
            with psycopg.connect(uri) as conn:
                assert conn.execute("SELECT snapshot->'orderNumbers' FROM native_ledger_heads WHERE owner_id=%s",
                                    (owner,)).fetchone()[0] == numbers
        finally:
            server.execute(sql.SQL('DROP DATABASE {} WITH (FORCE)').format(sql.Identifier(name)))
