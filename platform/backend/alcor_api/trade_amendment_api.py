from uuid import UUID

from .actual_fee_api import Member, Submission
from .trade_amendments import TradeAmendments


def mount_trade_amendments(app):
    service=TradeAmendments(app.state.db,getattr(app.state,'source_authority',None));app.state.trade_amendments=service
    fallback=[r for r in app.router.routes if getattr(r,'path',None) in ('/api/{path:path}','/{path:path}')]
    app.router.routes[:]=[r for r in app.router.routes if r not in fallback]
    @app.get('/api/trading/corrections')
    async def snapshot(who:Member,recordId:str):return await service.snapshot(who,recordId)
    @app.post('/api/trading/corrections/preview')
    async def preview(data:dict,who:Member):return await service.preview(who,data)
    @app.post('/api/trading/corrections/operations')
    async def submit(data:Submission,who:Member):return await service.submit(who,data.data,data.preview)
    @app.get('/api/trading/corrections/operations/{request_id}')
    async def receipt(request_id:UUID,who:Member):return await service.receipt(who,request_id)
    app.router.routes.extend(fallback)
