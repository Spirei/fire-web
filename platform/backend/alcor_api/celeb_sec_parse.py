"""SEC filing facts, preserving original identity, units and absent economics."""

import json
import re
from decimal import Decimal
from xml.etree import ElementTree as ET

from .celeb_returns import exact


def filings(raw, cik, kind):
    value = json.loads(raw)
    if str(value.get("cik", "")).zfill(10) != cik:
        raise ValueError("sec_cik_mismatch")
    recent = value.get("filings", {}).get("recent", {})
    forms = recent.get("form", [])
    if not isinstance(forms, list) or len(forms) > 100000:
        raise ValueError("filing_budget")
    result = []
    for i, form in enumerate(forms):
        if not isinstance(form, str) or not (
            form.startswith("13F-HR") if kind == "13f" else form in {"4", "4/A"}
        ):
            continue
        item = {
            k: recent.get(k, [])[i] if i < len(recent.get(k, [])) else None
            for k in ("accessionNumber", "filingDate", "reportDate", "primaryDocument")
        }
        if not isinstance(item["accessionNumber"], str) or not re.fullmatch(
            r"\d{10}-\d{2}-\d{6}", item["accessionNumber"]
        ):
            raise ValueError("accession_invalid")
        item.update(form=form, cik=cik)
        result.append(item)
    return result


def parse_xml(raw, kind):
    if re.search(rb"<!DOCTYPE|<!ENTITY", raw, re.IGNORECASE):
        raise ValueError("xml_entities_forbidden")
    try:
        root = ET.fromstring(raw)
    except ET.ParseError as exc:
        raise ValueError("sec_xml_invalid") from exc

    def local(node):
        return node.tag.rsplit("}", 1)[-1].lower()

    def nodes(parent, name):
        return [n for n in parent.iter() if local(n) == name.lower()]

    def text(parent, name):
        found = nodes(parent, name)
        return "".join(found[0].itertext()).strip() if found else None

    holdings = []
    trades = []
    if kind == "13f":
        rows = nodes(root, "infoTable")
        if len(rows) > 50000:
            raise ValueError("holdings_budget")
        for row in rows:
            holdings.append(
                {
                    "code": None,
                    "name": text(row, "nameOfIssuer"),
                    "market": None,
                    "cusip": text(row, "cusip"),
                    "securityTitle": text(row, "titleOfClass"),
                    "quantity": exact(text(row, "sshPrnamt")),
                    "sharesType": text(row, "sshPrnamtType"),
                    "putCall": text(row, "putCall"),
                    "valueReported": exact(text(row, "value")),
                    "valueUnit": "unknown",
                    "currency": None,
                    "price": None,
                    "cost": None,
                    "weight": None,
                    "weightDelta": None,
                    "isNew": None,
                }
            )
        values = [Decimal(h["valueReported"]) for h in holdings if h["valueReported"] is not None]
        total = sum(values, Decimal(0))
        if len(values) == len(holdings) and total > 0:
            for h in holdings:
                h["weight"] = format(Decimal(h["valueReported"]) / total * 100, "f")
    else:
        if not nodes(root, "ownershipDocument"):
            raise ValueError("ownership_document_missing")
        symbol = text(root, "issuerTradingSymbol")
        name = text(root, "issuerName")
        for row in nodes(root, "nonDerivativeHolding"):
            holdings.append(
                {
                    "code": symbol,
                    "name": name,
                    "market": None,
                    "securityTitle": text(row, "securityTitle"),
                    "quantity": exact(text(row, "sharesOwnedFollowingTransaction")),
                    "ownershipNature": text(row, "directOrIndirectOwnership"),
                    "currency": None,
                    "price": None,
                    "cost": None,
                    "weight": None,
                    "weightDelta": None,
                    "isNew": None,
                }
            )
        for row in nodes(root, "nonDerivativeTransaction"):
            trades.append(
                {
                    "code": symbol,
                    "name": name,
                    "market": None,
                    "securityTitle": text(row, "securityTitle"),
                    "date": text(row, "transactionDate"),
                    "quantity": exact(text(row, "transactionShares")),
                    "price": exact(text(row, "transactionPricePerShare")),
                    "transactionCode": text(row, "transactionCode"),
                    "acquiredDisposed": text(row, "transactionAcquiredDisposedCode"),
                    "quantityAfter": exact(text(row, "sharesOwnedFollowingTransaction")),
                    "currency": None,
                    "fees": None,
                    "authority": "sec_reported_insider_transaction_not_platform_execution",
                }
            )
    if not holdings and not trades:
        raise ValueError("no_reported_non_derivative_facts")
    return {
        "holdings": holdings,
        "trades": trades,
        "identityMapping": "issuer_symbol_only_no_cusip_guess",
        "unitsAuthority": "original_filing_unscaled",
        "actualPortfolioPerformanceKnown": False,
    }
