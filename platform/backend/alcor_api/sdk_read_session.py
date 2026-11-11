"""One bounded SDK import per Worker lane; observations are never cached here."""

import asyncio
import contextlib
import json
import os
import pwd
import sys
from pathlib import Path
from time import monotonic


class LatestSDKSession:
    def __init__(self, script=None, *, timeout=12, maximum=128):
        self.script = script or Path(__file__).with_name('market_futu_sdk.py')
        self.timeout, self.maximum = timeout, maximum
        self.lock = asyncio.Lock()
        self.process, self.target, self.reads = None, None, 0
        self.last_used = 0

    async def stop(self):
        process, self.process = self.process, None
        self.target, self.reads = None, 0
        self.last_used = 0
        if process is not None:
            if process.returncode is None:
                with contextlib.suppress(ProcessLookupError):
                    process.kill()
            await process.wait()

    async def close(self):
        async with self.lock:
            await self.stop()

    async def retire_idle(self):
        async with self.lock:
            if self.process is not None and monotonic()-self.last_used >= 90:
                await self.stop()

    async def read(self, payload):
        target = (payload['host'], payload['port'])
        # Waiting for this lane is bounded too. A waiting observer must not kill
        # another observer's active request if it times out before acquiring it.
        async with asyncio.timeout(self.timeout):
            async with self.lock:
                try:
                    if (self.process is None or self.process.returncode is not None
                            or self.target != target or self.reads >= self.maximum):
                        await self.stop()
                        self.process = await asyncio.create_subprocess_exec(
                            sys.executable, '-I', str(self.script), '--latest-stream',
                            stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE,
                            stderr=asyncio.subprocess.DEVNULL, limit=131073,
                            env={'PATH':'/usr/bin:/bin','PYTHONIOENCODING':'utf-8',
                                 'HOME':pwd.getpwuid(os.getuid()).pw_dir},
                        )
                        self.target = target
                    encoded = json.dumps(payload, allow_nan=False, separators=(',',':')).encode()
                    if len(encoded) > 16384:
                        raise ValueError('sdk_request_too_large')
                    self.process.stdin.write(encoded+b'\n')
                    await self.process.stdin.drain()
                    raw = await self.process.stdout.readline()
                    self.reads += 1
                    self.last_used = monotonic()
                    if not raw.endswith(b'\n') or not 1 < len(raw) <= 131072:
                        raise ValueError('sdk_response_too_large_or_incomplete')
                    result = json.loads(raw)
                    if not isinstance(result, dict):
                        raise ValueError('sdk_response_invalid')
                    if result.get('error'):
                        # A refused security cannot poison later independent
                        # reads. The child closes that request's quote context.
                        raise SDKReadRejected('sdk_unavailable_or_read_failed')
                    return raw
                except SDKReadRejected:
                    raise
                except BaseException:
                    # No late stdout can become the next security's response.
                    await self.stop()
                    raise


class SDKReadRejected(ValueError):
    pass
