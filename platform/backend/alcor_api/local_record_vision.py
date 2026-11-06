"""Explicit local Apple Vision runner. No shell, configurable executable or network."""
import asyncio
import os
import stat
import hashlib
import json
import platform
import fcntl
import sys
import tempfile
from pathlib import Path

from fastapi import HTTPException


async def command(arguments, directory, timeout, limit):
    process = await asyncio.create_subprocess_exec(*arguments, cwd=directory,
        env={'PATH':'/usr/bin:/bin','TMPDIR':str(directory),'LANG':'en_US.UTF-8'},
        stdin=asyncio.subprocess.DEVNULL, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
    async def read(stream, budget):
        output=bytearray()
        while chunk:=await stream.read(65536):
            if len(output)+len(chunk)>budget:raise ValueError('vision_output_budget')
            output.extend(chunk)
        return bytes(output)
    try:
        async with asyncio.timeout(timeout):
            output,error=await asyncio.gather(read(process.stdout,limit),read(process.stderr,65536))
            code=await process.wait()
        if code:raise HTTPException(503,'Apple Vision运行环境或识别工具不可用')
        return output
    finally:
        if process.returncode is None:
            process.kill()
            await process.wait()


def private_directory(path):
    try:path.mkdir(mode=0o700)
    except FileExistsError:pass
    info=path.lstat()
    if not stat.S_ISDIR(info.st_mode) or info.st_uid!=os.getuid() or stat.S_IMODE(info.st_mode)!=0o700:
        raise HTTPException(503,'Apple Vision私有缓存权限无法核对')
    return path


def read_private(path,limit,mode):
    descriptor=os.open(path,os.O_RDONLY|os.O_NOFOLLOW)
    with os.fdopen(descriptor,'rb') as stream:
        info=os.fstat(stream.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_uid!=os.getuid() or info.st_nlink!=1 or stat.S_IMODE(info.st_mode)!=mode or info.st_size>limit:
            raise ValueError('vision_cache_identity')
        return stream.read(limit+1)


async def cached_binary(source,sdk,directory):
    source_sha=hashlib.sha256(source.read_bytes()).hexdigest()
    identity={'sourceSha256':source_sha,'sdk':sdk,'architecture':platform.machine()}
    key=hashlib.sha256(json.dumps(identity,sort_keys=True).encode()).hexdigest()
    root=private_directory(Path(tempfile.gettempdir())/('alcor-record-vision-'+str(os.getuid())))
    cache=private_directory(root/key);binary=cache/'vision-ocr';manifest=cache/'manifest.json'
    if binary.is_symlink() or manifest.is_symlink():raise HTTPException(503,'Apple Vision缓存不能是符号链接')
    descriptor=os.open(cache/'compile.lock',os.O_CREAT|os.O_RDWR|os.O_NOFOLLOW,0o600)
    try:
        info=os.fstat(descriptor)
        if not stat.S_ISREG(info.st_mode) or info.st_uid!=os.getuid() or info.st_nlink!=1 or stat.S_IMODE(info.st_mode)!=0o600:raise ValueError('vision_cache_lock')
        await asyncio.to_thread(fcntl.flock,descriptor,fcntl.LOCK_EX)
        try:
            saved=json.loads(read_private(manifest,8192,0o600))
            body=read_private(binary,32*1024*1024,0o700)
            if saved=={**identity,'sha256':hashlib.sha256(body).hexdigest()}:return binary
        except (OSError,ValueError,TypeError):pass
        built=directory/'compiled-vision'
        await command(['/usr/bin/xcrun','swiftc','-O','-sdk',sdk,'-module-cache-path',str(directory/'modules'),str(source),'-o',str(built)],directory,180,65536)
        built.chmod(0o700);body=read_private(built,32*1024*1024,0o700)
        # Same-filesystem private staging and atomic rename; the manifest is committed last.
        for path,data,mode in ((binary,body,0o700),(manifest,json.dumps({**identity,'sha256':hashlib.sha256(body).hexdigest()},sort_keys=True).encode(),0o600)):
            fd,temp=tempfile.mkstemp(prefix='.pending-',dir=cache)
            try:
                os.fchmod(fd,mode)
                with os.fdopen(fd,'wb') as stream:stream.write(data);stream.flush();os.fsync(stream.fileno())
                os.replace(temp,path)
            finally:
                if os.path.exists(temp):os.unlink(temp)
        return binary
    finally:
        fcntl.flock(descriptor,fcntl.LOCK_UN);os.close(descriptor)


async def recognize(raw, mime):
    if sys.platform!='darwin':raise HTTPException(503,'Apple Vision需要macOS及Xcode或Command Line Tools')
    source=Path(__file__).parent/'data/record-vision-ocr.swift'
    if not source.is_file() or not Path('/usr/bin/xcrun').is_file():raise HTTPException(503,'Apple Vision工具尚未安装')
    with tempfile.TemporaryDirectory(prefix='alcor-record-vision-') as temporary:
        directory=Path(temporary);directory.chmod(0o700)
        image=directory/('snapshot.'+{'image/png':'png','image/jpeg':'jpg','image/gif':'gif','image/webp':'webp'}[mime])
        image.write_bytes(raw);image.chmod(0o600)
        sdk=(await command(['/usr/bin/xcrun','--sdk','macosx','--show-sdk-path'],directory,15,8192)).decode().strip()
        if not sdk.startswith(('/Applications/','/Library/Developer/')) or not sdk.endswith('.sdk') or not Path(sdk).is_dir():raise HTTPException(503,'Apple Vision SDK不可用')
        binary=await cached_binary(source,sdk,directory)
        return await command([str(binary),str(image)],directory,30,1000000)
