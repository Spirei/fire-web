"""Reuse the identity-checked latest-lane fixture without a second provider authority."""

from market_latest_candidate.test_market_authority import market, market_settings  # noqa: F401 -- shared isolated fixtures
