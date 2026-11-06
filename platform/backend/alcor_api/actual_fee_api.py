from typing import Annotated
from uuid import UUID
from fastapi import Depends
from pydantic import BaseModel,ConfigDict,Field
from .security import Identity,identity
from .actual_fee_confirmations import ActualFeeConfirmations

Member=Annotated[Identity,Depends(identity)]
class Submission(BaseModel):
    model_config=ConfigDict(extra='forbid')
    data:dict
    preview:str=Field(min_length=1,max_length=128)


def mount_actual_fee_confirmations(app):
    service=ActualFeeConfirmations(app.state.db,app.state.source_authority);app.state.actual_fee_confirmations=service
    fallback=[r for r in app.router.routes if getattr(r,'path',None) in ('/api/{path:path}','/{path:path}')]
    app.router.routes[:]=[r for r in app.router.routes if r not in fallback]
    @app.get('/api/fees/confirmations')
    async def snapshot(who:Member,brokerAccountId:str):return await service.snapshot(who,brokerAccountId)
    @app.post('/api/fees/confirmations/preview')
    async def preview(data:dict,who:Member):return await service.preview(who,data)
    @app.post('/api/fees/confirmations/operations')
    async def submit(data:Submission,who:Member):return await service.submit(who,data.data,data.preview)
    @app.get('/api/fees/confirmations/operations/{request_id}')
    async def receipt(request_id:UUID,who:Member):return await service.receipt(who,request_id)
    app.router.routes.extend(fallback)
