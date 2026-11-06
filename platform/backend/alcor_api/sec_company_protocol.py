"""SEC company directory/submissions protocol, independent of local asset coverage.

No network or configuration side effects. A directory maps ticker to CIK; a
submission describes the legal filer, never an account holding or security quote.
"""

import json
import re
from dataclasses import asdict, dataclass
from hashlib import sha256
from ipaddress import ip_address

from .fx_provider_parser import unique

SOURCE = "sec-submissions-v1"
PURPOSE = "company-profile"
DIRECTORY = "https://www.sec.gov/files/company_tickers.json"
LIMIT = 8 * 1024 * 1024
CODE = re.compile(r"[A-Z0-9._-]{1,20}\Z", re.ASCII)
CIK = re.compile(r"[0-9]{10}\Z", re.ASCII)


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=True)


def document(raw):
    if not isinstance(raw, bytes) or not raw or len(raw) > LIMIT:
        raise ValueError("sec_page_budget")
    value = json.loads(raw, object_pairs_hook=unique,
                       parse_constant=lambda _: (_ for _ in ()).throw(ValueError("sec_nonfinite")))
    if not isinstance(value, dict):
        raise TypeError("sec_document_shape")
    return value


def ticker(value):
    if not isinstance(value, str):
        raise TypeError("sec_ticker_invalid")
    value = value.strip()
    if not value.isascii() or not CODE.fullmatch(value.upper()):
        raise TypeError("sec_ticker_invalid")
    return value.upper()


def company_directory(raw):
    root = document(raw)
    if len(root) > 100000:
        raise ValueError("sec_directory_budget")
    result = {}
    for key, row in root.items():
        if not key.isascii() or not key.isdigit() or not isinstance(row, dict):
            raise ValueError("sec_directory_shape")
        code = ticker(row.get("ticker"))
        cik = row.get("cik_str")
        title = row.get("title")
        if type(cik) is not int or not 1 <= cik <= 9999999999 or not isinstance(title, str) or not title or len(title) > 4096:
            raise ValueError("sec_directory_identity")
        entry = {"cik": str(cik).zfill(10), "title": title, "ticker": code}
        if code in result and result[code] != entry:
            raise ValueError("sec_directory_collision")
        result[code] = entry
    return result


def submissions(raw, entry):
    value = document(raw)
    expected = entry["cik"]
    supplied = value.get("cik")
    if isinstance(supplied, bool) or not isinstance(supplied, (str, int)) or not str(supplied).isascii() or not str(supplied).isdigit() or str(supplied).zfill(10) != expected:
        raise ValueError("sec_submission_identity")
    # SEC may describe several share classes; never assign a different ticker's filer.
    tickers = value.get("tickers")
    if not isinstance(tickers, list) or len(tickers) > 10000 or entry["ticker"] not in [ticker(item) for item in tickers]:
        raise ValueError("sec_submission_ticker_mismatch")
    return value


@dataclass(frozen=True)
class Target:
    """Operator installation only: exact SEC hosts, approved public DNS pins, declared UA."""
    id: str
    directory_addresses: tuple[str, ...]
    submissions_addresses: tuple[str, ...]
    user_agent: str

    def validate(self):
        if not isinstance(self.id, str) or not self.id or len(self.id) > 128:
            raise ValueError("sec_target_id")
        if not isinstance(self.user_agent, str) or not 8 <= len(self.user_agent) <= 256 or not self.user_agent.isascii() or any(ord(c) < 32 or ord(c) == 127 for c in self.user_agent) or not re.search(r"[^\s@]+@[^\s@]+\.[^\s@]+", self.user_agent):
            raise ValueError("sec_declared_user_agent_required")
        for addresses in (self.directory_addresses, self.submissions_addresses):
            if not isinstance(addresses, (tuple, list)) or not 1 <= len(addresses) <= 32:
                raise ValueError("sec_dns_approval_required")
            for address in addresses:
                if not isinstance(address, str) or not ip_address(address).is_global or ip_address(address).is_multicast or ip_address(address).is_reserved:
                    raise ValueError("sec_public_pin_required")
        return self

    @property
    def fingerprint(self):
        self.validate()
        return sha256(canonical(asdict(self)).encode()).hexdigest()

    def request(self, cik=None):
        self.validate()
        if cik is not None and (not isinstance(cik, str) or not CIK.fullmatch(cik)):
            raise ValueError("sec_cik_invalid")
        host = "data.sec.gov" if cik is not None else "www.sec.gov"
        path = f"/submissions/CIK{cik}.json" if cik is not None else "/files/company_tickers.json"
        addresses = self.submissions_addresses if cik is not None else self.directory_addresses
        return f"https://{host}{path}", {"target": ("https", host, 443, path), "addresses": list(addresses)}
