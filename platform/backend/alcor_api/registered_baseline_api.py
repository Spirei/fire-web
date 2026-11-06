from typing import Annotated
from uuid import UUID
from fastapi import Depends,Query,Response
from pydantic import BaseModel,ConfigDict,Field
from .security import Identity,identity
from .registered_fee_baselines import RegisteredFeeBaselines

Member=Annotated[Identity,Depends(identity)]
class Submission(BaseModel):
    model_config=ConfigDict(extra='forbid')
    data:dict
    preview:str=Field(min_length=1,max_length=128)


def mount_registered_baselines(app):
    service=RegisteredFeeBaselines(app.state.db,app.state.source_authority);app.state.registered_fee_baselines=service
    fallback=[route for route in app.router.routes if getattr(route,'path',None) in ('/api/{path:path}','/{path:path}')]
    app.router.routes[:]=[route for route in app.router.routes if route not in fallback]
    @app.get('/api/fees/baselines')
    async def head(response:Response,who:Member,brokerAccountId:str=Query(min_length=1,max_length=100)):
        response.headers['Cache-Control']='no-store'
        return await service.head(who,brokerAccountId)
    @app.post('/api/fees/baselines/preview')
    async def preview(data:dict,who:Member):return await service.preview(who,data)
    @app.post('/api/fees/baselines/operations')
    async def submit(data:Submission,who:Member):return await service.submit(who,data.data,data.preview)
    @app.get('/api/fees/baselines/operations/{request_id}')
    async def receipt(request_id:UUID,who:Member):return await service.receipt(who,request_id)
    app.router.routes.extend(fallback)
