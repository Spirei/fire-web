"""Read the existing estimate head without initializing any financial collection."""
from typing import Annotated
from fastapi import Depends,Query,Response
from .broker_accounts import broker_account,serialize_brokers
from .security import Identity,identity,lock_mutation_identity

Member=Annotated[Identity,Depends(identity)]


async def estimate_head(service,who,account_id):
    # Use the same owner ordering as FeeEstimates, but not Trading.lock, which
    # intentionally initializes a collection for mutations. This path is SELECT
    # only, including no audit event or synthetic initial revision row.
    async with service.db.connection() as conn,conn.transaction():
        await serialize_brokers(conn,who.id)
        await lock_mutation_identity(conn,who,require_admin=False)
        await broker_account(conn,who.id,account_id)
        head=await(await conn.execute('SELECT revision,request_id FROM legacy_fee_estimation_heads WHERE owner_id=%s AND account_id=%s',(who.id,account_id))).fetchone()
        return {'brokerAccountId':account_id,'revision':head['revision'] if head else 0,'requestId':str(head['request_id']) if head else None}


def mount_fee_estimate_head(app):
    service=app.state.fee_estimates
    fallback=[route for route in app.router.routes if getattr(route,'path',None) in ('/api/{path:path}','/{path:path}')]
    app.router.routes[:]=[route for route in app.router.routes if route not in fallback]
    @app.get('/api/fees/estimates')
    async def head(response:Response,who:Member,brokerAccountId:str=Query(min_length=1,max_length=100)):
        response.headers['Cache-Control']='no-store'
        return await estimate_head(service,who,brokerAccountId)
    app.router.routes.extend(fallback)
