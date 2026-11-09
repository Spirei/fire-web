import ipaddress
import os
from pathlib import Path
from typing import Literal
from urllib.parse import urlsplit
from uuid import UUID

from pydantic import BaseModel, Field, SecretStr, field_validator, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

ROOT = Path(os.environ.get("ALCOR_ROOT", Path(__file__).resolve().parents[2]))


class RestoreTarget(BaseModel):
    id: str = Field(pattern=r"^[a-z0-9][a-z0-9_-]{2,63}$")
    name: str = Field(min_length=1, max_length=80)
    database_url: SecretStr
    instance_id: UUID
    data_directory: Path
    recovery_directory: Path
    environment: Literal["test"] = "test"


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="ALCOR_", extra="ignore", hide_input_in_errors=True)
    environment: Literal["local", "test", "staging", "production"] = "local"
    database_url: SecretStr | None = None
    redis_url: SecretStr | None = None
    instance_id: UUID | None = None
    public_origin: str = "http://127.0.0.1:8088"
    trusted_proxy_ips: list[str] = Field(default_factory=list, max_length=16)
    connections_from_environment: bool = False
    web_dist: Path = ROOT / "apps/web/dist"
    migration_dir: Path = ROOT / "migrations"
    inventory_file: Path = ROOT / "contracts/migration-register.json"
    capability_file: Path = ROOT / "contracts/api-capabilities.json"
    pool_size: int = 5
    pool_min_size: int = 0
    pool_max_lifetime: int = 1800
    pool_max_idle: int = 600
    connect_timeout: int = 3
    session_hours: int = 24
    registration_setup_token: SecretStr | None = None
    worker_poll_seconds: float = 1
    lease_seconds: int = 30
    connection_secret_dir: Path | None = None
    legacy_source_registry_path: Path | None = None
    resource_import_registry_path: Path | None = None
    attachment_import_registry_path: Path | None = None
    watch_group_import_registry_path: Path | None = None
    watch_group_icon_import_registry_path: Path | None = None
    font_import_registry_path: Path | None = None
    operational_source_registry_path: Path | None = None
    connection_targets: list[dict] = []
    fx_provider_targets: list[dict] = []
    business_notification_targets: list[dict] = []
    market_data_policies: list[dict] = []
    public_market_data_policies: list[dict] = []
    public_market_source_targets: list[dict] = []
    public_discovery_policies: list[dict] = []
    public_discovery_targets: list[dict] = []
    public_earnings_targets: list[dict] = []
    public_reference_policies: list[dict] = []
    public_sec_targets: list[dict] = []
    dividend_source_targets: list[dict] = []
    sec_company_targets: list[dict] = []
    broker_statement_targets: list[dict] = []
    sec_financial_targets: list[dict] = []
    market_discovery_targets: list[dict] = []
    earnings_targets: list[dict] = []
    record_ocr_targets: list[dict] = []
    card_ocr_targets: list[dict] = []
    local_clipboard_users: list[str] = []
    public_ticker: dict = {}
    feed_targets: list[dict] = []
    celeb_source_targets: list[dict] = []
    asset_source_targets: list[dict] = []
    feed_model_targets: list[dict] = []
    provider_model_targets: list[dict] = []
    active_model_service_id: str = ""
    email_link_origin: str = ""
    backup_dir: Path | None = None
    backup_secret_dir: Path | None = None
    file_root: Path | None = None
    public_upload_root: Path | None = None
    asset_root: Path | None = None
    pg_tools_dir: Path | None = None
    backup_max_bytes: int = Field(default=64 * 1024 * 1024, ge=1024 * 1024, le=512 * 1024 * 1024)
    backup_stream_max_bytes: int = Field(default=2 * 1024**3, ge=1024**2, le=64 * 1024**3)
    backup_stream_max_objects: int = Field(default=10000, ge=16, le=1000000)
    backup_stream_disk_reserve_bytes: int = Field(default=256 * 1024**2, ge=16 * 1024**2, le=16 * 1024**3)
    backup_stream_seconds: int = Field(default=1800, ge=120, le=86400)
    restore_targets: list[RestoreTarget] = []
    mail_enabled: bool = False
    mail_host: str = Field(default="", max_length=253)
    mail_port: int = Field(default=587, ge=1, le=65535)
    mail_username: SecretStr | None = None
    mail_password: SecretStr | None = None
    mail_sender: str = Field(default="", max_length=254)
    mail_from_name: str = Field(default="", max_length=120)
    mail_delivery_policy: dict = {}
    mail_tls: Literal["starttls", "tls"] = "starttls"
    mail_timeout: float = Field(default=10, ge=1, le=30)
    deployment_config_revision: UUID | None = None
    deployment_checks_workflow: str = Field(default='docker-publish.yml', pattern=r'^[A-Za-z0-9_.-]+\.yml$')
    deployment_repository: str = Field(default='', pattern=r'^(?:[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+)?$')
    deployment_image: str = Field(default='', pattern=r'^(?:ghcr\.io/[a-z0-9._-]+/[a-z0-9._-]+)?$')
    deployment_github_token: SecretStr | None = None
    deployment_github_client_id: str = ""
    deployment_github_client_secret: SecretStr | None = None
    deployment_runner_token: SecretStr | None = None
    deployment_running_image: str = Field(default='', pattern=r'^(?:ghcr\.io/[a-z0-9._/-]+@sha256:[a-f0-9]{64})?$')
    source_revision: str = Field(default="", pattern=r"^(?:[a-f0-9]{40})?$")
    deployment_updater_url: str = ""

    @field_validator("trusted_proxy_ips")
    @classmethod
    def exact_proxy_addresses(cls, values):
        # No wildcard, network range, host name, or implicit trust in private networks.
        return list(dict.fromkeys(str(ipaddress.ip_address(value)) for value in values))

    @model_validator(mode="after")
    def validate_target(self):
        url = urlsplit(self.public_origin)
        if (
            url.scheme not in {"http", "https"}
            or not url.netloc
            or url.path
            or url.query
            or url.fragment
            or url.username
        ):
            raise ValueError("public_origin must be an exact HTTP(S) origin")
        if self.environment not in {"local", "test"} and url.scheme != "https":
            raise ValueError("staging/production require HTTPS")
        if self.database_url and not self.instance_id:
            raise ValueError("database access requires an explicit instance_id")
        if self.instance_id and self.instance_id.int == 0:
            raise ValueError("replace the placeholder instance_id before startup")
        if not 1 <= self.pool_size <= 20 or not 1 <= self.session_hours <= 168:
            raise ValueError("invalid pool or session budget")
        if not 10 <= self.lease_seconds <= 300 or not 0.1 <= self.worker_poll_seconds <= 30:
            raise ValueError("invalid worker budget")
        if self.mail_enabled:
            import re
            if not self.mail_host or any(c.isspace() or ord(c) < 32 for c in self.mail_host):
                raise ValueError("enabled mail requires a valid host")
            if not re.fullmatch(r"[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+", self.mail_sender):
                raise ValueError("enabled mail requires an envelope sender")
            if bool(self.mail_username) != bool(self.mail_password):
                raise ValueError("mail username and password must be configured together")
        if self.deployment_runner_token and len(self.deployment_runner_token.get_secret_value()) < 32:
            raise ValueError("Watchtower token requires at least 32 characters")
        if bool(self.deployment_repository) != bool(self.deployment_image):
            raise ValueError("deployment repository and image must be configured together")
        if self.deployment_updater_url:
            updater = urlsplit(self.deployment_updater_url)
            if (updater.scheme != "http" or updater.hostname not in {"fire-updater", "alcor-watchtower", "alcor-api-watchtower", "watchtower", "alcor-api-updater", "localhost", "127.0.0.1", "::1"}
                    or not updater.netloc or updater.path not in {"", "/v1/update"} or updater.query or updater.fragment or updater.username):
                raise ValueError("Watchtower must use the private Docker network or loopback and fixed update endpoint")
        return self

    @property
    def secure_cookie(self):
        return self.public_origin.startswith("https://")
