from fastapi import FastAPI
from alcor_api.fire_api_surface import catalogue


def test_api_catalogue_retains_business_category_and_real_openapi_contract():
    app = FastAPI()
    @app.get('/api/auth/example', summary='示例接口', description='当前会话读取', tags=['identity'])
    def example(limit: int = 5):
        return {'limit': limit}
    result = catalogue(app, document={'revision':'synthetic', 'operations':[{'method':'GET','path':'/api/auth/example','owner':'platform'}]})
    item = result['items'][0]
    assert item['status'] == 'connected'
    assert item['category'] == '账号与安全'
    assert item['summary'] == '示例接口' and item['description'] == '当前会话读取'
    assert item['parameters'][0]['name'] == 'limit'
    assert '200' in item['responses']


def test_catalogue_groups_versioned_account_and_market_operations():
    app = FastAPI()
    @app.get('/api/v1/account-assets')
    def account():
        return {}
    @app.get('/api/v2/market-ranking')
    def market():
        return {}
    result = catalogue(app, document={'revision':'synthetic', 'operations':[]})
    assert {item['category'] for item in result['items']} == {'账户资产', '行情与市场'}


def test_catalogue_groups_native_authorities_instead_of_catch_all_bucket():
    app = FastAPI()
    def read():
        return {}
    for path in ('/api/account/card-wallet', '/api/client/cash-overview', '/api/admin/fees', '/api/account/passkeys'):
        app.add_api_route(path, read, methods=['GET'])
    result = catalogue(app, document={'revision':'synthetic', 'operations':[]})
    assert {item['category'] for item in result['items']} == {'卡面与卡包', '资金与现金', '交易费用', '账号与安全'}
