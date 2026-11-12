"""Public DNS rotation for the fixed quote origins, never arbitrary provider URLs."""
import ipaddress
import os
import re
from urllib.parse import unquote, urlsplit

from .fx_provider_parser import approved_target

HOSTS = {
    'tencent': ('qt.gtimg.cn', 'web.ifzq.gtimg.cn'),
    'eastmoney': ('push2delay.eastmoney.com', 'push2.eastmoney.com'),
    'yahoo': ('query1.finance.yahoo.com', 'query2.finance.yahoo.com'),
}


def public_addresses(values):
    if not isinstance(values,(list,tuple)) or not 1<=len(values)<=32:
        raise ValueError('address_not_approved')
    result=[]
    for value in values:
        try:address=ipaddress.ip_address(value)
        except (ValueError,TypeError):raise ValueError('address_not_approved') from None
        if not address.is_global or address.is_reserved or address.is_multicast:
            raise ValueError('address_not_approved')
        if getattr(address,'ipv4_mapped',None) and not address.ipv4_mapped.is_global:
            raise ValueError('address_not_approved')
        if isinstance(address,ipaddress.IPv6Address):
            if address.sixtofour is not None or address.teredo is not None:
                raise ValueError('address_not_approved')
            if address in ipaddress.ip_network('64:ff9b::/96') and not ipaddress.IPv4Address(int(address)&0xffffffff).is_global:
                raise ValueError('address_not_approved')
        if str(address) not in result:result.append(str(address))
    return tuple(result)


def validate_mode(target):
    if (target.source not in HOSTS or target.host not in HOSTS[target.source]
            or target.scheme!='https' or target.port!=443 or target.fixture or target.allow_plaintext):
        raise ValueError('public_quote_origin_required')
    public_addresses(target.addresses)


def fixed_quote_url(parsed):
    host,path=parsed.hostname,parsed.path
    return parsed.scheme=='https' and (parsed.port or 443)==443 and (
        host=='qt.gtimg.cn' and re.fullmatch(r'/q=(?:us|hk|sh|sz|bj|jp|kr)[A-Z0-9._]+',path)
        or host=='web.ifzq.gtimg.cn' and path=='/appstock/app/minute/query'
        or host in HOSTS['eastmoney'] and path=='/api/qt/ulist.np/get'
        or host in HOSTS['yahoo'] and path.startswith('/v8/finance/chart/')
        and unquote(path.removeprefix('/v8/finance/chart/')) not in ('','.','..')
        and not any(c in unquote(path.removeprefix('/v8/finance/chart/')) for c in '/\\'))


def local_public_quote_pins(url,approval):
    """An explicit local mode uses only existing approved public pins, never fake IPs."""
    if os.environ.get('FIRE_QUOTE_DNS_MODE','system')!='approved_public_pins':return None
    if os.environ.get('FIRE_ENVIRONMENT') not in ('local','test'):
        raise ValueError('local_quote_dns_mode_required')
    if not fixed_quote_url(urlsplit(url)):return None
    # Keep the exact declared origin/path, saved address approval and TLS name.
    # This neither approves a DNS answer nor adds an address from the request.
    return public_addresses(quote_pins(url,approval,approval['addresses']))


def quote_pins(url,approval,resolved):
    # The exact declared origin/path still has to match before any socket opens.
    approved_target(url,approval,approval['addresses'])
    mode=approval.get('dnsPolicy')
    if mode is None:return approved_target(url,approval,resolved)
    if mode!='public_fixed_quote_host':raise ValueError('target_not_approved')
    parsed=urlsplit(url)
    if not fixed_quote_url(parsed):raise ValueError('target_not_approved')
    public_addresses(approval['addresses'])
    return public_addresses(resolved)
