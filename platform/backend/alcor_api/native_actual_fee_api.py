from uuid import UUID
from .actual_fee_api import Member, Submission
from .native_actual_fees import NativeActualFeeConfirmations


def mount_native_actual_fees(app):
    service=NativeActualFeeConfirmations(app.state.db);app.state.native_actual_fee_confirmations=service
    fallback=[r for r in app.router.routes if getattr(r,'path',None) in ('/api/{path:path}','/{path:path}')]
    app.router.routes[:]=[r for r in app.router.routes if r not in fallback]
    @app.get('/api/fees/confirmations/native')
    async def snapshot(who:Member,brokerAccountId:str):return await service.snapshot(who,brokerAccountId)
    @app.post('/api/fees/confirmations/native/preview')
    async def preview(data:dict,who:Member):return await service.preview(who,data)
    @app.post('/api/fees/confirmations/native/operations')
    async def submit(data:Submission,who:Member):return await service.submit(who,data.data,data.preview)
    @app.get('/api/fees/confirmations/native/operations/{request_id}')
    async def receipt(request_id:UUID,who:Member):return await service.receipt(who,request_id)
    app.router.routes.extend(fallback)
