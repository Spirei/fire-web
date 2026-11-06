"""Bounded authenticated framing for streaming backup archives (format 2).

Each bundle uses a fresh AES-256 key, wrapped by the existing Fernet backup key.
The authenticated empty final record makes truncation distinguishable from EOF.
"""

import hashlib
import io
import json
import secrets
import struct
from uuid import UUID

from cryptography.exceptions import InvalidTag
from cryptography.fernet import Fernet, InvalidToken
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

MAGIC = b"ALCOR-STREAM-2\n"
CHUNK = 1024 * 1024
MAX_CHUNK = 4 * CHUNK
HEADER_MAX = 65536
UINT = struct.Struct("!I")
ALGORITHM = "AES-256-GCM-records-v1"
KEY_CONTEXT = b"alcor-backup-stream-v2\x00"


class StreamFailure(Exception):
    pass


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()


def exact(source, size):
    chunks = []
    left = size
    while left:
        chunk = source.read(left)
        if not chunk or len(chunk) > left:
            raise StreamFailure("备份流不完整")
        chunks.append(chunk)
        left -= len(chunk)
    return b"".join(chunks)


def identifier(value):
    try:
        if not isinstance(value, str) or str(UUID(value)) != value:
            raise ValueError()
        return value
    except ValueError:
        raise StreamFailure("备份流身份无效") from None


class EncryptWriter:
    def __init__(self, target, wrapping_key, backup_id, source_instance, *, maximum, chunk_size=CHUNK):
        if (
            type(chunk_size) is not int
            or not 1 <= chunk_size <= MAX_CHUNK
            or type(maximum) is not int
            or maximum < 1
        ):
            raise ValueError("invalid stream limits")
        key = AESGCM.generate_key(bit_length=256)
        self.cipher = AESGCM(key)
        self.prefix = secrets.token_bytes(8)
        self.chunk_size = chunk_size
        self.maximum = maximum
        self.target = target
        self.buffer = bytearray()
        self.sequence = 0
        self.plain_bytes = 0
        self.encrypted_bytes = 0
        self.hasher = hashlib.sha256()
        self.sealed = False
        header = canonical(
            {
                "format": 2,
                "algorithm": ALGORITHM,
                "compression": "gzip-tar",
                "backup_id": identifier(backup_id),
                "source_instance": identifier(source_instance),
                "chunk_size": chunk_size,
                "nonce_prefix": self.prefix.hex(),
                "wrapped_key": Fernet(wrapping_key).encrypt(KEY_CONTEXT + key).decode(),
            }
        )
        self.binding = hashlib.sha256(header).digest()
        self._write(MAGIC + UINT.pack(len(header)) + header)

    def _write(self, raw):
        written = self.target.write(raw)
        if written is not None and written != len(raw):
            raise StreamFailure("备份存储未完整写入")
        self.encrypted_bytes += len(raw)
        self.hasher.update(raw)

    def _record(self, raw, final=False):
        if self.sequence >= 2**32:
            raise StreamFailure("备份流记录过多")
        number = UINT.pack(self.sequence)
        length = UINT.pack(len(raw))
        aad = self.binding + number + length + (b"\x01" if final else b"\x00")
        ciphertext = self.cipher.encrypt(self.prefix + number, raw, aad)
        self._write(length + ciphertext)
        self.sequence += 1

    def write(self, data):
        if self.sealed:
            raise StreamFailure("备份流已经封口")
        size = len(data)
        self.plain_bytes += size
        if self.plain_bytes > self.maximum:
            raise StreamFailure("备份流超过容量预算")
        view = memoryview(data)
        while view:
            take = min(len(view), self.chunk_size - len(self.buffer))
            self.buffer.extend(view[:take])
            view = view[take:]
            if len(self.buffer) == self.chunk_size:
                self._record(bytes(self.buffer))
                self.buffer.clear()
        return size

    def flush(self):
        if hasattr(self.target, "flush"):
            self.target.flush()

    def finish(self):
        if self.sealed:
            raise StreamFailure("备份流重复封口")
        if self.buffer:
            self._record(bytes(self.buffer))
            self.buffer.clear()
        self._record(b"", final=True)
        self.sealed = True
        self.flush()
        return self.encrypted_bytes, self.hasher.hexdigest()


class DecryptReader(io.RawIOBase):
    def __init__(self, source, wrapping_key, backup_id, source_instance, *, maximum):
        if type(maximum) is not int or maximum < 1:
            raise ValueError("invalid stream budget")
        self.source = source
        self.maximum = maximum
        self.sequence = 0
        self.plain_bytes = 0
        self.buffer = bytearray()
        self.done = False
        if exact(source, len(MAGIC)) != MAGIC:
            raise StreamFailure("备份流格式无效")
        size = UINT.unpack(exact(source, 4))[0]
        if not 1 <= size <= HEADER_MAX:
            raise StreamFailure("备份流头超过预算")
        raw = exact(source, size)
        try:
            header = json.loads(raw)
            if not isinstance(header, dict) or set(header) != {
                "format",
                "algorithm",
                "compression",
                "backup_id",
                "source_instance",
                "chunk_size",
                "nonce_prefix",
                "wrapped_key",
            }:
                raise ValueError()
            if (
                header["format"] != 2
                or header["algorithm"] != ALGORITHM
                or header["compression"] != "gzip-tar"
                or header["backup_id"] != identifier(backup_id)
                or header["source_instance"] != identifier(source_instance)
            ):
                raise ValueError()
            chunk_size = header["chunk_size"]
            if type(chunk_size) is not int or not 1 <= chunk_size <= MAX_CHUNK:
                raise ValueError()
            self.chunk_size = chunk_size
            self.prefix = bytes.fromhex(header["nonce_prefix"])
            if len(self.prefix) != 8 or self.prefix.hex() != header["nonce_prefix"]:
                raise ValueError()
            key = Fernet(wrapping_key).decrypt(header["wrapped_key"].encode())
            if not key.startswith(KEY_CONTEXT) or len(key) != len(KEY_CONTEXT) + 32:
                raise ValueError()
            self.cipher = AESGCM(key[len(KEY_CONTEXT) :])
            self.binding = hashlib.sha256(raw).digest()
        except (TypeError, ValueError, KeyError, AttributeError, InvalidToken):
            raise StreamFailure("备份流身份、密钥或头校验失败") from None

    def readable(self):
        return True

    def _record(self):
        if self.sequence >= 2**32:
            raise StreamFailure("备份流记录过多")
        size = UINT.unpack(exact(self.source, 4))[0]
        if size > self.chunk_size:
            raise StreamFailure("备份流记录超过预算")
        number = UINT.pack(self.sequence)
        aad = self.binding + number + UINT.pack(size) + (b"\x01" if size == 0 else b"\x00")
        ciphertext = exact(self.source, size + 16)
        try:
            plain = self.cipher.decrypt(self.prefix + number, ciphertext, aad)
        except (InvalidTag, ValueError):
            raise StreamFailure("备份流认证校验失败") from None
        self.sequence += 1
        if size == 0:
            if self.source.read(1):
                raise StreamFailure("备份流封口后存在额外内容")
            self.done = True
            return
        self.plain_bytes += size
        if self.plain_bytes > self.maximum:
            raise StreamFailure("备份流超过容量预算")
        self.buffer.extend(plain)

    def read(self, size=-1):
        if not isinstance(size, int) or size < 0 or size > MAX_CHUNK:
            raise StreamFailure("备份流必须使用有界块读取")
        while len(self.buffer) < size and not self.done:
            self._record()
        result = bytes(self.buffer[:size])
        del self.buffer[:size]
        return result

    def readinto(self, buffer):
        raw = self.read(len(buffer))
        buffer[: len(raw)] = raw
        return len(raw)

    def finish(self):
        while self.read(CHUNK):
            pass
        if not self.done:
            raise StreamFailure("备份流缺少认证封口")
