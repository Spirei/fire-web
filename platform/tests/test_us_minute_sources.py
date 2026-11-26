import json
from datetime import datetime

from alcor_api.market_contract import Query
from alcor_api import market_eastmoney_minute, market_tencent_minute, market_yahoo_history


def test_tencent_observations_and_publication_time_remain_distinct():
    query = Query('price_series','US','GOOGL','minute','none','ALL',start='2026-11-25',through='2026-11-25')
    raw = {'code':0,'data':{'usGOOGL':{'data':{'date':'20261125','data':['0930 264.52 1672025','1600 273.10 41283672']},
                                        'pandata':{'tag':'after','last':'274.99','time':'2026-11-25 20:15:00'}}}}
    rows, issues, _ = market_tencent_minute.parse(json.dumps(raw).encode(),query)
    assert not issues and len(rows) == 2
    assert rows[-1]['at'] == '2026-11-25T21:00:00+00:00'


def test_eastmoney_prints_use_shanghai_date_and_new_york_trading_day():
    query = Query('price_series','US','GOOGL','minute','none','ALL',start='2026-11-25',through='2026-11-25')
    raw={'rc':0,'data':{'market':105,'code':'GOOGL','trends':['2026-11-26 05:00,0,273.10,274,271,25,300,272']}}
    facts,issues,_ = market_eastmoney_minute.parse(json.dumps(raw).encode(),query)
    assert not issues and facts[0]['price']=='273.10' and facts[0]['at']=='2026-11-25T21:00:00+00:00'


def test_yahoo_us_extended_minutes_keep_provider_timestamp():
    query = Query('bars','US','GOOGL','minute','none','ALL',start='2026-11-25',through='2026-11-25')
    epoch = int(datetime.fromisoformat('2026-11-25T19:59:35-05:00').timestamp())
    raw={'chart':{'error':None,'result':[{'meta':{'symbol':'GOOGL','currency':'USD','instrumentType':'EQUITY','dataGranularity':'1m'},
        'timestamp':[epoch],'indicators':{'quote':[{k:[274.89] for k in ('open','close','low','high')}]}}]}}
    facts,issues,_=market_yahoo_history.parse(json.dumps(raw).encode(),query)
    assert not issues and facts[0]['at']=='2026-11-26T00:59:35+00:00' and facts[0]['session']=='ALL'
