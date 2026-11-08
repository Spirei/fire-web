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
    assert {item['category'] for item in result['items']} == {'持仓与分析', '行情与市场'}


def test_catalogue_groups_native_authorities_instead_of_catch_all_bucket():
    app = FastAPI()
    def read():
        return {}
    for path in ('/api/account/card-wallet', '/api/client/cash-overview', '/api/admin/fees', '/api/account/passkeys'):
        app.add_api_route(path, read, methods=['GET'])
    result = catalogue(app, document={'revision':'synthetic', 'operations':[]})
    assert {item['category'] for item in result['items']} == {'卡面与卡包', '资金与账本', '交易与券商', '账号与安全'}


def test_catalogue_fingerprint_changes_with_real_router_contract():
    app = FastAPI()
    def read():
        return {}
    app.add_api_route('/api/example', read, methods=['GET'])
    first = catalogue(app)
    assert catalogue(app) is first
    app.add_api_route('/api/example', read, methods=['POST'])
    changed = catalogue(app)
    assert changed['etag'] != first['etag']
    assert catalogue(app) is changed


def test_compact_groups_keep_all_operations_and_original_alcor_feature_numbers():
    app = FastAPI()
    def read():
        return {}
    paths = ('/api/quote-subscriptions', '/api/market-ranking', '/api/kline',
             '/api/auth/example', '/api/account/close', '/api/account/changes')
    for path in paths:
        app.add_api_route(path, read, methods=['GET'])
    result = catalogue(app, document={'revision':'synthetic', 'operations':[]})
    assert result['summary']['total'] == len(paths)
    assert {item['category'] for item in result['items']} == {'行情与市场', '账号与安全'}
    for item in result['items']:
        assert item['categoryNumber'] == (6 if item['category'] == '行情与市场' else 1)
        assert isinstance(item['subcategoryOrder'], int)
        assert 'subcategoryNumber' not in item
        assert item['subcategory']
        assert item['categoryFeatureIds'] == (
            ['F15', 'F16', 'F17', 'F18'] if item['category'] == '行情与市场'
            else ['F01', 'F02', 'F04', 'F20', 'F32']
        )
        assert item['client_acceptance'] == 'pending'


def test_original_feature_number_is_bound_to_the_exact_method_and_path():
    app = FastAPI()
    def read():
        return {}
    app.add_api_route('/api/v2/quote-subscriptions', read, methods=['GET'])
    app.add_api_route('/api/auth/example', read, methods=['GET'])
    result = catalogue(app, document={'revision':'synthetic', 'operations':[]})
    items = {item['path']:item for item in result['items']}
    assert items['/api/v2/quote-subscriptions']['featureIds'] == ['F15']
    assert items['/api/auth/example']['featureIds'] == [], 'category membership cannot invent a legacy binding'
