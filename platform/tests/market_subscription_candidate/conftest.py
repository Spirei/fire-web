import pytest_asyncio
from market_latest_candidate.test_market_authority import market
from price_alerts_candidate.test_price_alerts import alert_settings

__all__ = ['alert_settings', 'market']


@pytest_asyncio.fixture
async def market_settings(alert_settings):
    return alert_settings
