from uuid import uuid4
from alcor_api.fee_rules import VERSION

async def financial(db):
    async with db.connection() as conn:
        return {table:await(await conn.execute('SELECT * FROM '+table+' ORDER BY 1')).fetchall() for table in ('trade_ledger','cash_ledger_entries','portfolio_records','cash_ledger_collections','trade_fee_corrections','trade_fee_projections','trade_fee_details','fee_legacy_inventory_orders')}


def command(admin,exported,account,order,fill,revision=0):
    return {'requestId':str(uuid4()),'manifestId':exported['manifestId'],'targetUserId':admin,'brokerAccountId':account,'expectedRevision':revision,'ruleVersion':VERSION,'plan':{'effectiveFrom':'2025-05-14','effectiveThrough':'2026-10-20','confirmed':True},'selections':[{'originalOrderId':order,'tradeId':fill['tradeId'],'instrumentKind':'us_domestic_equity','wholeOrderConfirmed':True}],'registeredBaselineConfirmed':True,'estimatedOnlyConfirmed':True}
