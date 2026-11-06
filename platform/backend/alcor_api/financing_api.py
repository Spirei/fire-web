from typing import Literal
from uuid import UUID

from .actual_fee_api import Member, Submission
from .financing_policies import FinancingPolicies


def mount_financing(app):
    service=FinancingPolicies(app.state.db);app.state.financing_policies=service
    fallback=[route for route in app.router.routes if getattr(route,'path',None) in ('/api/{path:path}','/{path:path}')]
    app.router.routes[:]=[route for route in app.router.routes if route not in fallback]
    @app.get('/api/financing/policy')
    async def snapshot(who:Member,accountKind:Literal['real','simulated']):return await service.snapshot(who,accountKind)
    @app.post('/api/financing/policy/preview')
    async def preview(data:dict,who:Member):return await (source if 'manifestId' in data else service).preview(who,data)
    @app.post('/api/financing/policy/operations')
    async def submit(data:Submission,who:Member):return await (source if 'manifestId' in data.data else service).submit(who,data.data,data.preview)
    @app.get('/api/financing/policy/operations/{request_id}')
    async def receipt(request_id:UUID,who:Member):return await service.receipt(who,request_id)
    from .financing_source_policy import FinancingSourcePolicies
    source=FinancingSourcePolicies(app.state.db,app.state.source_authority)
    app.state.financing_source_policies=source
    @app.get('/api/financing/policy/source')
    async def source_snapshot(who:Member,accountKind:Literal['real','simulated']):return await source.options(who,accountKind)
    app.router.routes.extend(fallback)
