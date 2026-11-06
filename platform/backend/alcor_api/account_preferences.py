"""Account-owned appearance and manually chosen status, persisted only in PostgreSQL."""

from typing import Annotated, Literal
from uuid import UUID, uuid4

from fastapi import APIRouter, Depends, HTTPException, Request
from psycopg.types.json import Jsonb
from pydantic import BaseModel, Field, field_validator, model_validator

from .models import InputModel
from .security import Identity, identity, lock_mutation_identity

router = APIRouter(prefix="/api/account/preferences", tags=["accounts"])
Member = Annotated[Identity, Depends(identity)]
Font = (
    Literal["system", "sans", "serif", "mono"]
    | Annotated[str, Field(pattern=r"^custom-[1-9][0-9]*-[a-f0-9]{64}\.(woff2?|ttf|otf)$", max_length=128)]
)
Hex = Annotated[str, Field(pattern=r"^#[0-9a-fA-F]{6}$")]


class PalettePreference(InputModel):
    theme: Literal["alcor", "neutral-gray", "muse", "meta", "soft", "contrast", "custom"]
    style: Literal["neutral", "neutral-gray", "muse", "meta"]
    accent: Literal["default", "blue", "green", "yellow", "pink", "orange", "purple", "black", "custom"]
    customAccent: Hex
    background: Hex | None
    foreground: Hex | None
    font: Font


class AppearancePreference(InputModel):
    version: Literal[1]
    assetBrokerOrder: list[str] = Field(default_factory=list, max_length=500)
    assetMarketOrder: list[Literal["US", "HK", "CN", "JP", "KR", "SG", "UK", "DE", "FR", "AU", "CA", "IN", "TW", "BR"]] = Field(default_factory=lambda: ["US", "HK", "CN", "JP", "KR", "SG", "UK", "DE", "FR", "AU", "CA", "IN", "TW", "BR"], min_length=1, max_length=14)

    @field_validator("assetBrokerOrder")
    @classmethod
    def broker_order(cls, value):
        import re
        if len(set(value)) != len(value) or any(not re.fullmatch(r"[A-Za-z0-9:._-]{1,120}", v) for v in value):
            raise ValueError("券商排序无效")
        return value

    @field_validator("assetMarketOrder")
    @classmethod
    def unique_asset_markets(cls, value):
        if len(set(value)) != len(value):
            raise ValueError("市场不能重复")
        return value

    fxOrder: list[Annotated[str, Field(pattern=r"^[A-Z]{3}$")]] = Field(default_factory=lambda: ["USD", "EUR", "HKD", "CNY", "JPY", "KRW", "SGD", "GBP", "AUD", "CAD", "TWD", "CHF", "INR", "BRL"], min_length=1, max_length=64)
    fxHidden: list[Annotated[str, Field(pattern=r"^[A-Z]{3}$")]] = Field(default_factory=list, max_length=64)

    @field_validator("fxOrder", "fxHidden")
    @classmethod
    def unique_currencies(cls, value):
        if len(set(value)) != len(value):
            raise ValueError("币种不能重复")
        return value

    @model_validator(mode="after")
    def visible_fx_currency(self):
        if not set(self.fxOrder) - set(self.fxHidden):
            raise ValueError("至少保留一个显示币种")
        return self

    mode: Literal["system", "light", "dark"]
    separateModes: bool
    shared: PalettePreference
    light: PalettePreference
    dark: PalettePreference
    uiSize: int = Field(ge=12, le=20)
    contentSize: int = Field(ge=12, le=24)
    codeSize: int = Field(ge=10, le=20)
    motion: Literal["system", "on", "off"]
    translucent: bool
    contrast: int = Field(ge=0, le=100)
    fullWidth: bool
    contentWidth: Literal["compact", "standard", "wide"]
    contentAlign: Literal["left", "center"]
    sidebarCollapsed: bool
    pointer: bool
    smoothing: bool
    uiStyle: Literal["regular", "medium"]
    contentStyle: Literal["regular", "medium"]
    codeStyle: Literal["regular", "medium"]
    contentFont: Literal["same"] | Font
    codeFont: Literal["system", "mono"]


class PreferenceOut(BaseModel):
    appearance: AppearancePreference | None
    avatar_status: Literal["online", "focus", "doNotDisturb"]
    revision: UUID | None


class PreferenceChange(InputModel):
    revision: UUID | None
    appearance: AppearancePreference | None = None
    avatar_status: Literal["online", "focus", "doNotDisturb"] | None = None


async def read_preferences(conn, user_id):
    return await (
        await conn.execute(
            "SELECT appearance,avatar_status,revision FROM account_preferences WHERE user_id=%s", (user_id,)
        )
    ).fetchone() or {"appearance": None, "avatar_status": "online", "revision": None}


@router.get("", response_model=PreferenceOut)
async def get_preferences(request: Request, who: Member):
    async with request.app.state.db.connection() as conn:
        return await read_preferences(conn, who.id)


@router.patch("", response_model=PreferenceOut)
async def save_preferences(data: PreferenceChange, request: Request, who: Member):
    fields = data.model_fields_set - {"revision"}
    if not fields or ("avatar_status" in fields and data.avatar_status is None):
        raise HTTPException(422, "设置内容无效")
    async with request.app.state.db.connection() as conn, conn.transaction():
        await conn.execute(
            "SELECT pg_advisory_xact_lock(hashtextextended(%s,0))", ("identity-management:" + who.id,)
        )
        await lock_mutation_identity(conn, who, require_admin=False)
        await conn.execute(
            "SELECT pg_advisory_xact_lock(hashtextextended(%s,0))", ("account-preferences:" + who.id,)
        )
        old = await read_preferences(conn, who.id)
        if old["revision"] != data.revision:
            raise HTTPException(409, "设置已在其他页面或设备更新，请核对后重试")
        appearance = (
            data.appearance.model_dump()
            if "appearance" in fields and data.appearance
            else None
            if "appearance" in fields
            else old["appearance"]
        )
        if appearance is not None and data.appearance is not None and old["appearance"]:
            for key in ("assetMarketOrder", "assetBrokerOrder", "fxOrder", "fxHidden"):
                if key not in data.appearance.model_fields_set:
                    appearance[key] = old["appearance"].get(key, appearance[key])
            try:
                appearance = AppearancePreference.model_validate(appearance).model_dump()
            except ValueError:
                raise HTTPException(422, "外观与币种设置无效，请重新读取") from None
        if "appearance" in fields and appearance is not None:
            fonts = {appearance[mode]["font"] for mode in ("shared", "light", "dark")}
            fonts.add(appearance["contentFont"])
            custom = sorted(value for value in fonts if value.startswith("custom-"))
            if custom:
                owned = await (
                    await conn.execute(
                        "SELECT id FROM personal_fonts WHERE owner_id=%s AND id=ANY(%s)", (who.id, custom)
                    )
                ).fetchall()
                if {row["id"] for row in owned} != set(custom):
                    raise HTTPException(422, "请先上传或选择本人已有字体")
        status = data.avatar_status if "avatar_status" in fields else old["avatar_status"]
        await conn.execute(
            """INSERT INTO account_preferences(user_id,appearance,avatar_status,revision) VALUES(%s,%s,%s,%s)
            ON CONFLICT(user_id) DO UPDATE SET appearance=excluded.appearance,avatar_status=excluded.avatar_status,revision=excluded.revision,updated_at=clock_timestamp()""",
            (who.id, Jsonb(appearance) if appearance is not None else None, status, uuid4()),
        )
        await conn.execute(
            "INSERT INTO audit_events(actor_id,action,request_id) VALUES(%s,'account.preferences.updated',%s)",
            (who.id, request.state.request_id),
        )
        return await read_preferences(conn, who.id)
