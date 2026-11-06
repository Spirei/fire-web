from typing import Annotated
from uuid import UUID

from fastapi import Depends,Response
from pydantic import BaseModel,ConfigDict,Field

from alcor_api.security import Identity,identity
from .source_authority import SourceAuthority,AuthorizedFinancialImport
from .source_read_access import source_read_lock

Member=Annotated[Identity,Depends(identity)]


class Registration(BaseModel):
    model_config=ConfigDict(extra='forbid')
    requestId:UUID
    sourceAlias:str=Field(min_length=1,max_length=100)
    sourceOwner:str=Field(min_length=1,max_length=200)
    targetUserId:str=Field(min_length=1,max_length=200)


class Consent(BaseModel):
    model_config=ConfigDict(extra='forbid')
    requestId:UUID
    revision:int=Field(ge=1,strict=True)
    password:str=Field(min_length=1,max_length=1024)
    code:str=Field(max_length=32)
    approve:bool


class Export(BaseModel):
    model_config=ConfigDict(extra='forbid')
    requestId:UUID
    grantRevision:int=Field(ge=1,strict=True)
    predecessorHash:str|None=Field(default=None,pattern='^[a-f0-9]{64}$')


class FinancialSubmission(BaseModel):
    model_config=ConfigDict(extra='forbid')
    data:dict=Field(max_length=12)
    preview:str=Field(min_length=1,max_length=128)


def mount_source_authority(app,settings,registry):
    # Source capability exists only when explicitly registered by the operator;
    # the regular product server/environment alone never grants source access.
    authority=SourceAuthority(app.state.db,registry,app.state.native_passkeys)
    service=AuthorizedFinancialImport(app.state.db,authority)
    app.state.source_authority=authority;app.state.authorized_financial_import=service
    fallback=[r for r in app.router.routes if getattr(r,'path',None) in ('/api/{path:path}','/{path:path}')]
    app.router.routes[:]=[r for r in app.router.routes if r not in fallback and not (getattr(r,'path','').startswith('/api/financial-import/'))]

    @app.post('/api/legacy-financial/authorizations')
    async def register(data:Registration,who:Member):return await authority.register(who,data.model_dump(mode='json'))

    @app.get('/api/legacy-financial/authorizations')
    async def grants(who:Member):return await authority.grants(who)

    @app.get('/api/legacy-financial/coverage')
    async def coverage(who:Member):
        from .scope_coverage import status
        async with authority.db.connection() as conn,conn.transaction():
            await source_read_lock(conn,who)
            return await status(conn,who.id)

    @app.get('/api/legacy-financial/export-budget')
    async def budget(who:Member):return await authority.budget(who)

    @app.post('/api/legacy-financial/authorizations/{grant_id}/consent')
    async def consent(grant_id:UUID,data:Consent,who:Member):return await authority.consent(who,grant_id,data.model_dump(mode='json'))

    @app.post('/api/legacy-financial/authorizations/{grant_id}/snapshots')
    async def export(grant_id:UUID,data:Export,who:Member):return await authority.export(who,grant_id,data.model_dump(mode='json'))

    @app.get('/api/legacy-financial/operations/{request_id}')
    async def receipt(request_id:UUID,who:Member):return await authority.receipt(who,request_id)

    @app.get('/api/legacy-financial/manifests/{manifest_id}')
    async def manifest(manifest_id:UUID,who:Member):return await authority.manifest(who,manifest_id)

    @app.get('/api/legacy-financial/manifests/{manifest_id}/raw')
    async def original(manifest_id:UUID,who:Member):
        raw,digest=await authority.raw_export(who,manifest_id)
        return Response(content=raw,media_type='application/json',headers={'cache-control':'no-store','etag':'"'+digest+'"','content-disposition':'attachment; filename="source-'+str(manifest_id)+'.json"'})

    @app.post('/api/financial-import/preview')
    async def finance_preview(data:dict,who:Member):return await service.preview(who,data)

    @app.post('/api/financial-import/operations')
    async def finance_submit(data:FinancialSubmission,who:Member):return await service.submit(who,data.data,data.preview)

    @app.get('/api/financial-import/operations/{request_id}')
    async def finance_receipt(request_id:UUID,who:Member):return await service.receipt(who,request_id)

    app.router.routes.extend(fallback)
    return app


def create_source_app(settings,registry):
    from alcor_api.main import create_app
    app=create_app(settings)
    return app if hasattr(app.state,'source_authority') else mount_source_authority(app,settings,registry)
