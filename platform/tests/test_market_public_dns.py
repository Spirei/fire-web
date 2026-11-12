"""Fixed quote hosts may rotate public DNS; private/custom targets stay pinned."""
from dataclasses import asdict, replace

import pytest
from alcor_api.dividend_sources import Target, canonical, digest
from alcor_api.market_public_dns import quote_pins


def target():
    return Target('owned-quotes','eastmoney','push2delay.eastmoney.com',443,('8.8.8.8',),
                  approved_access=True,dns_policy='public_dns')


def approval():
    value=target().approval('1.600519')
    value['target'][3]='/api/qt/ulist.np/get'
    return value


def test_public_address_rotation_keeps_the_fixed_https_origin_path_and_budget():
    value=target().validate('production')
    url='https://push2delay.eastmoney.com/api/qt/ulist.np/get?secids=1.600519'
    assert quote_pins(url,approval(),['1.1.1.1','2606:4700:4700::1111'])==('1.1.1.1','2606:4700:4700::1111')
    assert value.budget_key==replace(value,addresses=('1.1.1.1',)).budget_key
    # An already registered public-DNS target does not need a new policy merely
    # because its DNS answer changes; each connection pins the checked answer.
    assert value.fingerprint==target().fingerprint


@pytest.mark.parametrize('addresses',[
    [],['127.0.0.1'],['10.0.0.1'],['192.168.1.1'],['169.254.169.254'],['100.64.0.1'],
    ['::1'],['fe80::1'],['::ffff:127.0.0.1'],['224.0.0.1'],['198.18.0.1'],
    ['2002:7f00:1::'],['2001:0:4136:e378:8000:63bf:3fff:fdd2'],['64:ff9b::a00:1'],
    ['1.1.1.1','10.0.0.1'],['not-an-ip'],['1.1.1.1']*33,
])
def test_every_resolved_address_must_be_public_before_connecting(addresses):
    with pytest.raises(ValueError,match='address_not_approved'):
        quote_pins('https://push2delay.eastmoney.com/api/qt/ulist.np/get',approval(),addresses)


@pytest.mark.parametrize('change',[
    {'host':'attacker.example'}, {'host':'push2delay.eastmoney.com.attacker.example'},
    {'source':'futu'}, {'source':'coingecko'}, {'port':8443}, {'scheme':'http','allow_plaintext':True},
    {'allow_plaintext':True}, {'fixture':True}, {'addresses':('10.0.0.1',)},
])
def test_public_dns_mode_cannot_expand_to_custom_private_or_other_origins(change):
    with pytest.raises(ValueError):replace(target(),**change).validate('test')


@pytest.mark.parametrize('url',[
    'http://push2delay.eastmoney.com/api/qt/ulist.np/get',
    'https://push2delay.eastmoney.com:8443/api/qt/ulist.np/get',
    'https://other.example/api/qt/ulist.np/get',
    'https://push2delay.eastmoney.com/securities/api/data/v1/get',
    'https://user:password@push2delay.eastmoney.com/api/qt/ulist.np/get',
])
def test_wrong_origin_path_and_credentials_never_gain_dynamic_dns(url):
    value=approval()
    from urllib.parse import urlsplit
    parsed=urlsplit(url)
    value['target']=[parsed.scheme,parsed.hostname,parsed.port or (443 if parsed.scheme=='https' else 80),parsed.path]
    with pytest.raises(ValueError):quote_pins(url,value,['1.1.1.1'])


def test_legacy_pinned_fingerprint_and_strict_address_checks_do_not_change():
    value=replace(target(),dns_policy='pinned')
    original=asdict(value);original.pop('dns_policy')
    assert value.fingerprint==digest(canonical(original).encode())
    assert value.fingerprint!=target().fingerprint
    pins=approval();pins.pop('dnsPolicy')
    with pytest.raises(ValueError,match='address_not_approved'):
        quote_pins('https://push2delay.eastmoney.com/api/qt/ulist.np/get',pins,['1.1.1.1'])
    assert quote_pins('https://push2delay.eastmoney.com/api/qt/ulist.np/get',pins,['8.8.8.8'])==('8.8.8.8',)


@pytest.mark.parametrize('source,host,symbol',[
    ('tencent','qt.gtimg.cn','usAAPL'),('tencent','web.ifzq.gtimg.cn','sz002602'),
    ('yahoo','query1.finance.yahoo.com','^GSPC'),('yahoo','query2.finance.yahoo.com','0700.HK'),
])
def test_other_fixed_quote_protocols_keep_their_exact_origin_and_path(source,host,symbol):
    value=replace(target(),source=source,host=host).validate('production')
    declared=value.approval(symbol)
    assert quote_pins('https://'+host+value.path(symbol),declared,['1.1.1.1'])==('1.1.1.1',)


@pytest.mark.parametrize('source,host,symbol',[
    ('eastmoney','push2delay.eastmoney.com','1.600519'),('yahoo','query1.finance.yahoo.com','AAPL')])
async def test_wire_keeps_hostname_and_pins_one_resolution_without_following_redirect(monkeypatch,source,host,symbol):
    from alcor_api import dividend_source_transport as wire
    seen=[];resolutions=[];status=200
    class Response:
        async def __aenter__(self):self.status=status;return self
        async def __aexit__(self,*args):pass
        async def aiter_stream(self):yield b'provider-body'
    class Pool:
        def __init__(self,**kwargs):
            backend=kwargs['network_backend']
            assert backend.host==host and backend.addresses==('1.1.1.1',)
            assert kwargs['retries']==0 and kwargs['max_connections']==1
        async def __aenter__(self):return self
        async def __aexit__(self,*args):pass
        def stream(self,method,url,**kwargs):
            assert kwargs.get('headers',{})==({'User-Agent':'Mozilla/5.0','Accept':'application/json'} if source=='yahoo' else {})
            seen.append((method,url));return Response()
    async def resolve(host,port):resolutions.append((host,port));return ['1.1.1.1']
    monkeypatch.setattr(wire,'resolve',resolve)
    monkeypatch.setattr(wire.httpcore,'AsyncConnectionPool',Pool)
    declared=approval() if source=='eastmoney' else replace(target(),source=source,host=host).approval(symbol)
    url='https://'+host+declared['target'][3]
    assert await wire.fetch_page(url,declared)==b'provider-body'
    status=302
    with pytest.raises(wire.ResponseFailure) as refused:await wire.fetch_page(url,declared)
    assert refused.value.status==302 and refused.value.raw==b'provider-body'
    assert seen==[('GET',url),('GET',url)] and resolutions==[(host,443)]*2
