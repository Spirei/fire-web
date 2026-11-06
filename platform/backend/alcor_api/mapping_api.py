from typing import Annotated
from uuid import UUID
from fastapi import Depends
from pydantic import BaseModel,ConfigDict,Field
from alcor_api.security import Identity,identity
from .financial_mapping import FinancialMappings

Member=Annotated[Identity,Depends(identity)]
class Submission(BaseModel):
    model_config=ConfigDict(extra='forbid')
    data:dict
    preview:str=Field(min_length=1,max_length=128)


def mount_financial_mappings(app):
    service=FinancialMappings(app.state.db,app.state.source_authority)
    app.state.financial_mappings=service
    fallback=[r for r in app.router.routes if getattr(r,'path',None) in ('/api/{path:path}','/{path:path}')]
    app.router.routes[:]=[r for r in app.router.routes if r not in fallback]
    @app.post('/api/legacy-financial/mappings/preview')
    async def preview(data:dict,who:Member):return await service.preview(who,data)
    @app.post('/api/legacy-financial/mappings/operations')
    async def submit(data:Submission,who:Member):return await service.submit(who,data.data,data.preview)
    @app.get('/api/legacy-financial/mappings/operations/{request_id}')
    async def receipt(request_id:UUID,who:Member):return await service.receipt(who,request_id)
    @app.get('/api/legacy-financial/mappings')
    async def head(who:Member):return await service.head(who)
    app.router.routes.extend(fallback)
