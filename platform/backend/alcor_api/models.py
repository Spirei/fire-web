from datetime import date, datetime
import re
from typing import Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, SecretStr, field_validator, model_validator

TaskStatus = Literal["queued", "running", "cancel_requested", "cancelled", "succeeded", "failed"]


class InputModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


class LoginInput(InputModel):
    login: str = Field(min_length=1, max_length=254)
    password: str = Field(min_length=1, max_length=128)

    @field_validator("login", "password")
    @classmethod
    def valid_unicode(cls, value):
        value.encode("utf-8")
        return value


class UserOut(BaseModel):
    id: str
    username: str
    role: Literal["admin", "user"]


class RegisterInput(InputModel):
    setup_token: SecretStr | None = Field(default=None, max_length=512)
    username: str = Field(min_length=1, max_length=80)
    password: str = Field(min_length=1, max_length=128)

    @field_validator("username")
    @classmethod
    def username_format(cls, value):
        value = value.strip()
        if not re.fullmatch(r"[\w.-]{1,80}", value):
            raise ValueError("Invalid username")
        value.encode("utf-8")
        return value

    @field_validator("password")
    @classmethod
    def password_unicode(cls, value):
        value.encode("utf-8")
        return value


class RegistrationOut(BaseModel):
    requires_setup_token: bool = False
    first_user: bool


class SessionOut(BaseModel):
    user: UserOut
    instance_id: UUID
    csrf: str
    receipt_scope: str
    expires_at: datetime


class ProfileInput(InputModel):
    display_name: str = Field(max_length=80)
    avatar_data: str | None = Field(default=None, max_length=65500)
    revision: UUID | None

    @field_validator("display_name")
    @classmethod
    def valid_name(cls, value):
        value = value.strip()
        if any(ord(c) < 32 or ord(c) == 127 for c in value):
            raise ValueError("Invalid display name")
        value.encode("utf-8")
        return value


class ProfileOut(BaseModel):
    username: str
    display_name: str
    avatar_revision: UUID | None
    revision: UUID | None


class ActivityDay(BaseModel):
    date: date
    login: int
    tasks: int
    profile: int


class ActivityOut(BaseModel):
    timezone: str
    start: date
    end: date
    observed_since: date
    observed_at: datetime
    days: list[ActivityDay]


class TaskInput(InputModel):
    request_id: UUID
    kind: Literal["system.diagnostics", "backup.create", "backup.verify", "backup.restore"] = (
        "system.diagnostics"
    )
    backup_id: UUID | None = None
    target_id: str | None = Field(default=None, max_length=64)
    restore_ticket: str | None = Field(default=None, max_length=4096)

    @model_validator(mode="after")
    def task_arguments(self):
        supplied = (self.backup_id is not None, self.target_id is not None, self.restore_ticket is not None)
        expected = (
            (True, True, True)
            if self.kind == "backup.restore"
            else (True, False, False)
            if self.kind == "backup.verify"
            else (False, False, False)
        )
        if supplied != expected:
            raise ValueError("Invalid task arguments")
        return self


class TaskOut(BaseModel):
    id: UUID
    owner_id: str
    request_id: UUID
    kind: str
    status: TaskStatus
    attempts: int
    result: dict | None
    error_code: str | None
    created_at: datetime
    started_at: datetime | None
    finished_at: datetime | None


class EventOut(BaseModel):
    id: int
    phase: str
    created_at: datetime


class TaskDetail(TaskOut):
    events: list[EventOut]


class TaskList(BaseModel):
    items: list[TaskOut]
    next_cursor: str | None


class ServiceOut(BaseModel):
    id: str
    label: str
    state: Literal["up", "down", "unconfigured", "pending"]
    configured: bool = False
    detail: str
    observed_at: datetime | None = None


class OverviewOut(BaseModel):
    version: str
    build: int
    environment: str
    topology: Literal["single-app-external-pg-redis"]
    services: list[ServiceOut]
    task_counts: dict[str, int]
    compatibility: dict[str, bool]
