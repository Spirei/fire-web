import json
from typing import Annotated, Literal

from fastapi import Depends, HTTPException, Request, Response
from pydantic import BaseModel, Field, field_validator, model_validator

from .identity_management import IdentityManagement
from .identity_passkey_management import PasskeyManagement
from .identity_passkeys import Passkeys
from .identity_service import FACTOR_COOKIE
from .models import InputModel, SessionOut
from .security import Identity, administrator, digest, identity, trusted_origin


class FactorChallengeOut(BaseModel):
    status: Literal['requires_2fa']
    challenge_token: str
    expires_in: int
    factors: list[str]


class FactorLogin(InputModel):
    challenge_token: str = Field(pattern=r'^flc_[A-Za-z0-9_-]{43}$')
    code: str = Field(min_length=6,max_length=32)


def mount_identity_routes(app,settings,db,service,create_session,session_response,rate_limit):
    @app.post('/api/session/login/totp',response_model=SessionOut,tags=['session'])
    async def finish_totp(data:FactorLogin,request:Request,response:Response):
        trusted_origin(request)
        address=request.client.host if request.client else 'unknown'
        if not await rate_limit(db,digest('identity-factor-ip:'+address),40):
            raise HTTPException(429,'尝试过于频繁，请稍后再试')
        user,token,session=await service.finish_password(data.challenge_token,data.code,request.cookies.get(FACTOR_COOKIE,''),request.state.request_id,create_session)
        response.delete_cookie(FACTOR_COOKIE,path='/')
        return session_response(response,user,token,session)

    passkeys=Passkeys(settings,db,service)
    app.state.native_passkeys=passkeys
    key_management=PasskeyManagement(settings,db,passkeys)
    app.state.passkey_management=key_management

    @app.get('/api/session/passkeys/config',tags=['session'])
    async def passkey_config():
        return await key_management.config()

    @app.get('/api/account/passkeys',tags=['account-security'])
    async def list_keys(who:Annotated[Identity,Depends(identity)]):
        return await key_management.list(who)

    @app.post('/api/session/passkeys',tags=['session'])
    async def passkey_login(data:PasskeyLoginAction,request:Request,response:Response):
        trusted_origin(request)
        address=request.client.host if request.client else 'unknown'
        if not await rate_limit(db,digest('identity-passkey-ip:'+address),30):
            raise HTTPException(429,'尝试过于频繁，请稍后再试')
        if data.action=='login-options':return await passkeys.login_options(request,response)
        if data.action=='login-verify':
            user,token,session=await passkeys.login_verify(data,request,response,create_session)
            return session_response(response,user,token,session)

    @app.post('/api/account/passkeys',tags=['account-security'])
    async def passkey_registration(data:PasskeyRegisterAction,request:Request,response:Response,who:Annotated[Identity,Depends(identity)]):
        await factor_budget(request,who)
        if data.action=='register-options':return await passkeys.register_options(data,request,response,who)
        return await passkeys.register_verify(data,request,who)

    management=IdentityManagement(settings,db,service,passkeys)
    app.state.identity_management=management

    async def factor_budget(request,who):
        if not await rate_limit(db,digest('identity-manage:'+who.id),20):
            raise HTTPException(429,'尝试过于频繁，请稍后再试')

    @app.get('/api/account/totp',tags=['account-security'])
    async def totp_status(who:Annotated[Identity,Depends(identity)]):return await management.status(who)

    @app.post('/api/auth/totp/setup',tags=['account-security'])
    async def totp_setup(data:StepUpInput,request:Request,who:Annotated[Identity,Depends(identity)]):
        await factor_budget(request,who)
        return await management.setup(data,who)

    @app.post('/api/auth/totp/confirm',tags=['account-security'])
    async def totp_confirm(data:TotpConfirm,request:Request,who:Annotated[Identity,Depends(identity)]):
        await factor_budget(request,who)
        return await management.confirm(data,who)

    @app.post('/api/auth/totp/disable',tags=['account-security'])
    async def totp_disable(data:StepUpInput,request:Request,who:Annotated[Identity,Depends(identity)]):
        await factor_budget(request,who)
        return await management.disable(data,who)

    @app.post('/api/auth/totp/backup-codes',tags=['account-security'])
    async def totp_backup_codes(data:StepUpInput,request:Request,who:Annotated[Identity,Depends(identity)]):
        await factor_budget(request,who)
        return await management.regenerate(data,who)

    @app.put('/api/account/passkeys/config',tags=['account-security'])
    async def set_passkey_config(data:PasskeyConfigInput,request:Request,who:Annotated[Identity,Depends(administrator)]):
        await factor_budget(request,who)
        return await key_management.configure(data,who)

    @app.patch('/api/account/passkeys',tags=['account-security'])
    async def rename_passkey(data:PasskeyManage,request:Request,who:Annotated[Identity,Depends(identity)]):
        await factor_budget(request,who)
        return await key_management.rename(data,who)

    @app.delete('/api/account/passkeys',tags=['account-security'])
    async def remove_passkey(data:PasskeyManage,request:Request,who:Annotated[Identity,Depends(identity)]):
        await factor_budget(request,who)
        return await key_management.remove(data,who)

    from .web_email_registration import mount_web_email_registration
    mount_web_email_registration(app, settings, db, create_session, session_response, rate_limit)


class IdentityInput(InputModel):
    @field_validator('name',check_fields=False)
    @classmethod
    def label(cls,value):
        value=value.strip()
        if not value or any(ord(char)<32 or ord(char)==127 for char in value):
            raise ValueError('Invalid label')
        return value


class PasskeyAction(IdentityInput):
    action: Literal['login-options','login-verify','register-options','register-verify']
    requestId: str = Field(default='',max_length=128)
    response: dict = Field(default_factory=dict)
    password: str = Field(default='',max_length=128)
    code: str = Field(default='',max_length=32)
    name: str = Field(default='通行密钥',min_length=1,max_length=64)

    @model_validator(mode='after')
    def bounded(self):
        if len(json.dumps(self.response))>32768:raise ValueError('Credential response too large')
        return self


class PasskeyLoginAction(PasskeyAction):
    action: Literal['login-options','login-verify']


class PasskeyRegisterAction(PasskeyAction):
    action: Literal['register-options','register-verify']


class StepUpInput(IdentityInput):
    password: str = Field(min_length=1,max_length=128)
    code: str = Field(default='',max_length=32)

class TotpConfirm(StepUpInput):
    challengeId: str = Field(min_length=1,max_length=128)
    name: str = Field(default='身份验证应用',min_length=1,max_length=64)

class PasskeyConfigInput(StepUpInput):
    enabled: bool
    origin: str = Field(max_length=1024)
    name: str = Field(default='Alcor',min_length=1,max_length=64)
    revision: str = Field(max_length=128)

class PasskeyManage(StepUpInput):
    password: str = Field(default='',max_length=128)
    id: str = Field(min_length=1,max_length=2048)
    name: str = Field(default='通行密钥',min_length=1,max_length=64)
