"""Compile legacy JavaScript regex out of process, then persist bounded slots."""

import asyncio
import json
import shutil
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

SCRIPT = r"""const fs=require('node:fs'); const raw=JSON.parse(fs.readFileSync(0,'utf8'));let source=raw.trim(),flags='';let match=/^\/((?:\\\/|[^/])+)\/([a-z]*)$/.exec(source);if(match){source=match[1];flags=match[2].replace(/g/g,'');}let re;try{re=new RegExp(source,flags)}catch{re=null}let slots=[];if(re&&source)for(let h=0;h<24;h++)for(let m=0;m<60;m++){let s=String(h).padStart(2,'0')+':'+String(m).padStart(2,'0');re.lastIndex=0;if(re.test(s)&&slots.length<96)slots.push(s);}process.stdout.write(JSON.stringify(slots.length?slots:['09:00','23:00']));"""

_COMPILERS = asyncio.Semaphore(1)


async def compile_schedule(pattern, timezone):
    async with asyncio.timeout(3):
        async with _COMPILERS:
            return await _compile_schedule(pattern, timezone)


async def _compile_schedule(pattern, timezone):
    if not isinstance(pattern, str) or len(pattern) > 200 or not isinstance(timezone, str):
        raise ValueError("schedule_invalid")
    try:
        ZoneInfo(timezone)
    except (ZoneInfoNotFoundError, ValueError):
        raise ValueError("timezone_invalid") from None
    compiler = shutil.which("node")
    if not compiler:
        raise ValueError("schedule_compiler_unavailable")
    process = await asyncio.create_subprocess_exec(
        compiler,
        "--max-old-space-size=16",
        "-e",
        SCRIPT,
        stdin=asyncio.subprocess.PIPE,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.DEVNULL,
        env={"PATH": "/usr/local/bin:/usr/bin:/bin"},
    )
    try:
        output, _ = await asyncio.wait_for(process.communicate(json.dumps(pattern).encode()), 2)
    except (TimeoutError, asyncio.CancelledError):
        if process.returncode is None:
            process.kill()
        await process.wait()
        raise
    if process.returncode != 0:
        raise ValueError("schedule_compile_failed")
    return {"pattern": pattern, "timezone": timezone, "slots": json.loads(output)}


def current_slot(schedule, now):
    if now.tzinfo is None:
        raise ValueError("timezone_required")
    local = now.astimezone(ZoneInfo(schedule["timezone"]))
    slot = local.strftime("%H:%M")
    # Same local minute during DST fold intentionally shares one persistent key.
    return (local.date(), slot) if slot in schedule["slots"] else None
