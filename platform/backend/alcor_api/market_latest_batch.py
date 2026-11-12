"""Short, bounded SDK request coalescing; no quote cache or financial state."""

import asyncio
import json

from .sdk_read_session import SDKReadRejected


class LatestBatch:
    def __init__(self, session, *, maximum=20, delay=.1):
        if type(maximum) is not int or not 1 <= maximum <= 20 or not 0 <= delay <= .1:
            raise ValueError('sdk_batch_bounds_invalid')
        self.session, self.maximum, self.delay = session, maximum, delay
        self.pending = {}
        self.tasks = set()
        self.closed = False

    async def read(self, scope, payload):
        if self.closed:
            raise SDKReadRejected('sdk_batch_closed')
        if payload.get('action') != 'latest' or len(payload.get('symbols', [])) != 1 or payload.get('cursor') is not None:
            raise ValueError('sdk_batch_latest_symbol_required')
        # Query semantics and approved target stay isolated. Only the code can
        # differ inside one market/source/license/session batch.
        query = {key: value for key, value in payload['query'].items() if key != 'code'}
        key = (scope, payload['host'], payload['port'], json.dumps(query, sort_keys=True))
        entries = self.pending.get(key)
        if entries is None or len(entries) >= self.maximum:
            if len(self.tasks) >= 20:
                raise SDKReadRejected('sdk_batch_capacity')
            entries = []
            self.pending[key] = entries
            task = asyncio.create_task(self.flush(key, entries))
            self.tasks.add(task)
            task.add_done_callback(self.tasks.discard)
        future = asyncio.get_running_loop().create_future()
        future.add_done_callback(lambda done: None if done.cancelled() else done.exception())
        entries.append((payload, future))
        try:
            return await asyncio.shield(future)
        finally:
            if not future.done():
                future.cancel()

    async def flush(self, key, entries):
        try:
            await asyncio.sleep(self.delay)
            if self.pending.get(key) is entries:
                del self.pending[key]
            active = [(payload, future) for payload, future in entries if not future.done()]
            if not active:
                return
            symbols = sorted({payload['symbols'][0] for payload, _ in active})
            payload = {**active[0][0], 'symbols': symbols}
            raw = await self.session.read(payload)
            value = json.loads(raw)
            if not isinstance(value, dict) or not isinstance(value.get('records'), list):
                raise SDKReadRejected('sdk_batch_response_invalid')
            if ('realTimeRecords' in value and not isinstance(value['realTimeRecords'], list)
                    or 'skipped' in value and not isinstance(value['skipped'], list)):
                raise SDKReadRejected('sdk_batch_response_invalid')
            for original, future in active:
                if future.done():
                    continue
                symbol = original['symbols'][0]
                records = [row for row in value['records'] if isinstance(row, dict) and row.get('code') == symbol]
                if not records:
                    future.set_exception(SDKReadRejected('sdk_security_unavailable'))
                    continue
                # This is the exact SDK scalar representation for this requested
                # security, not wire bytes. No price, time or baseline is derived.
                own = {**value, 'records': records, 'requestSymbols': symbols}
                if 'realTimeRecords' in own:
                    own['realTimeRecords'] = [row for row in own['realTimeRecords'] if isinstance(row, dict) and row.get('code') == symbol]
                if 'skipped' in own:
                    own['skipped'] = [code for code in own['skipped'] if code == symbol]
                future.set_result(json.dumps(own, ensure_ascii=False, allow_nan=False, separators=(',', ':')).encode())
        except BaseException as error:
            for _, future in entries:
                if not future.done():
                    if isinstance(error, asyncio.CancelledError):
                        future.cancel()
                    else:
                        future.set_exception(SDKReadRejected('sdk_batch_read_unavailable'))
            if isinstance(error, asyncio.CancelledError):
                raise

    async def close(self):
        self.closed = True
        tasks = tuple(self.tasks)
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        self.pending.clear()
