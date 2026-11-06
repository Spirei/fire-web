"""Discovery's legacy numeric DTO hashes survive JSONB numeric representation."""
from decimal import Decimal

import pytest
from alcor_api.market_contract import canonical
from alcor_api.market_discovery_protocol import digest


def test_discovery_numeric_hash_accepts_finite_numbers_without_relaxing_financial_commands():
    assert digest({'price':100.0,'values':[1.25,0.0]}) == digest({'price':100,'values':[Decimal('1.2500'),0]})
    assert digest({'price':1e20}) == digest({'price':100000000000000000000})
    for value in (float('nan'),float('inf'),Decimal('NaN')):
        with pytest.raises(ValueError):digest({'price':value})
    with pytest.raises(ValueError):canonical({'amount':1.25})
