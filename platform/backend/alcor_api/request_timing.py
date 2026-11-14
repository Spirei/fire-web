"""Request-local, metadata-only time-to-first-byte diagnostics; never store SQL or IDs."""
from contextlib import contextmanager
from contextvars import ContextVar
from time import perf_counter

from psycopg import AsyncConnection

_current = ContextVar('request_timing', default=None)
PHASES = {'pool_wait', 'db_guard', 'sql_execute', 'catalogue', 'json_encode',
          'read_admission_redis', 'read_admission_pg', 'history_proof', 'history_proof_wait',
          'history_authorize', 'history_select', 'history_evidence_load', 'history_assemble', 'history_admission'}


class RequestTiming:
    def __init__(self):
        self.started = perf_counter()
        self.durations = {}
        self.statements = 0
        self.active = True
        self.snapshot = None

    def header(self):
        if self.snapshot is not None:
            return self.snapshot
        parts = [f'backend_ttfb;dur={(perf_counter() - self.started) * 1000:.2f}']
        for phase in sorted(self.durations):
            suffix = f';desc="{self.statements} statements"' if phase == 'sql_execute' else ''
            parts.append(f'{phase};dur={self.durations[phase] * 1000:.2f}{suffix}')
        self.snapshot = ', '.join(parts).encode('ascii')
        self.active = False
        return self.snapshot


def begin():
    timing = RequestTiming()
    return timing, _current.set(timing)


def finish(timing, token):
    timing.active = False
    _current.reset(token)


def start():
    timing = _current.get()
    return perf_counter() if timing is not None and timing.active else None


def elapsed(phase, started, *, statement=False):
    timing = _current.get()
    if started is None or timing is None or not timing.active or phase not in PHASES:
        return
    timing.durations[phase] = timing.durations.get(phase, 0) + max(0, perf_counter() - started)
    if statement:
        timing.statements += 1


@contextmanager
def measure(phase, *, statement=False):
    started = start()
    try:
        yield
    finally:
        elapsed(phase, started, statement=statement)


class TimedConnection(AsyncConnection):
    async def execute(self, query, params=None, *, prepare=None, binary=False):
        started = start()
        if started is None:
            return await super().execute(query, params, prepare=prepare, binary=binary)
        try:
            return await super().execute(query, params, prepare=prepare, binary=binary)
        finally:
            elapsed('sql_execute', started, statement=True)
