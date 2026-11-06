import ipaddress
import re
from datetime import datetime
from typing import Annotated, Literal
from uuid import UUID

from pydantic import BaseModel, Field, SecretStr, field_validator, model_validator

from .models import InputModel

Kind = Literal["postgresql", "redis"]


class ConnectionBase(InputModel):
    host: str = Field(min_length=1, max_length=253)
    port: int = Field(ge=1, le=65535)
    username: str = Field(max_length=128)
    connect_timeout: int = Field(default=3, ge=1, le=5)

    @field_validator("host")
    @classmethod
    def host_format(cls, value):
        value = value.strip()
        if value.startswith("/"):
            if not re.fullmatch(r"/[A-Za-z0-9_./ -]+", value) or ".." in value.split("/"):
                raise ValueError("Invalid local socket")
            return value
        try:
            ipaddress.ip_address(value)
        except ValueError:
            if not re.fullmatch(r"[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?", value):
                raise ValueError("Invalid host") from None
        return value

    @field_validator("username")
    @classmethod
    def plain_text(cls, value):
        if any(ord(c) < 32 or ord(c) == 127 for c in value):
            raise ValueError("Invalid account")
        value.encode("utf-8")
        return value


class PostgresConfig(ConnectionBase):
    kind: Literal["postgresql"] = "postgresql"
    port: int = Field(default=5432, ge=1, le=65535)
    database: str = Field(min_length=1, max_length=128)
    schema_name: Literal["public"] = "public"
    ssl_mode: Literal["disable", "require", "verify-ca", "verify-full"] = "disable"
    pool_size: int = Field(default=5, ge=1, le=20)
    pool_min_size: int = Field(default=0, ge=0, le=20)
    max_lifetime: int = Field(default=1800, ge=60, le=86400)
    max_idle: int = Field(default=600, ge=10, le=3600)

    @field_validator("database")
    @classmethod
    def database_format(cls, value):
        return cls.plain_text(value)

    @model_validator(mode="after")
    def pool_bounds(self):
        if self.pool_min_size > self.pool_size:
            raise ValueError("Invalid pool bounds")
        return self


class RedisConfig(ConnectionBase):
    kind: Literal["redis"] = "redis"
    port: int = Field(default=6379, ge=1, le=65535)
    database: int = Field(default=0, ge=0, le=15)
    tls: bool = False
    max_connections: int = Field(default=10, ge=1, le=50)

    @model_validator(mode="after")
    def socket_tls(self):
        if self.host.startswith("/") and self.tls:
            raise ValueError("TLS requires a TCP endpoint")
        return self


Config = Annotated[PostgresConfig | RedisConfig, Field(discriminator="kind")]


class ConnectionInput(InputModel):
    request_id: UUID
    revision: UUID | None
    config: Config
    password_mode: Literal["keep", "replace", "clear"] = "keep"
    password: SecretStr | None = Field(default=None, max_length=1024)

    @model_validator(mode="after")
    def password_action(self):
        if self.password_mode == "replace" and (
            self.password is None or not self.password.get_secret_value()
        ):
            raise ValueError("Missing password")
        if self.password_mode != "replace" and self.password is not None:
            raise ValueError("Unexpected password")
        if self.password:
            self.password.get_secret_value().encode("utf-8")
        return self


class ConnectionSettingsOut(BaseModel):
    source: Literal["managed", "environment"] = "managed"
    config: Config | None
    effective: Config | None
    revision: UUID | None
    password_set: bool
    saved_at: datetime | None
    state: Literal["unconfigured", "applied", "pending"]
    worker_applied: bool = False


class ConnectionReceiptOut(BaseModel):
    request_id: UUID
    kind: Kind
    operation: Literal["test", "save"]
    status: Literal["passed", "failed", "saved", "pending", "unknown"]
    message: str
    observed_at: datetime
    revision: UUID | None = None
    postgres_version: str | None = None
