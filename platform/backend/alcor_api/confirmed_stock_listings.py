"""Verified listing identities, available before local artwork or quotes are imported."""

import json
from importlib.resources import files

from .asset_lookup_contract import normalize


def stock_identity(market, code):
    market = market.upper()
    return market, normalize(market, code)


def listing_material(listing):
    market, code = listing["market"], listing["code"]
    return {
        "id": f"stock:{market}:{code}",
        "type": "stock",
        "market": market,
        "code": code,
        "name": listing["name"],
        "fileVariants": [],
    }


CONFIRMED_LISTINGS = {
    stock_identity(item["market"], item["code"]): item
    for item in json.loads(files("alcor_api").joinpath("data/confirmed-stock-listings.json").read_text())
}
LISTING_MATERIALS = {item["id"]: item for item in map(listing_material, CONFIRMED_LISTINGS.values())}
