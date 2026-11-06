"""Optional identity never treats a supplied malformed Authorization as anonymous."""
import re

from fastapi import HTTPException

from .legacy_identity import OLD_COOKIE, WEB_COOKIE
from .security import COOKIE


def market_platform_session_selected(request):
    """Canonical market reads explicitly bind the displayed platform session.

    Legacy routes and explicit Authorization keep their original identity domain.
    This selects a credential only; identity() must still validate its binding.
    """
    return (
        request.url.path.startswith('/api/market/')
        and 'authorization' not in request.headers
        and bool(request.cookies.get(COOKIE))
        and bool(request.headers.get('x-csrf-token'))
    )


def credentials_present(request, *, platform=False):
    if 'authorization' in request.headers:
        values=request.headers.getlist('authorization')
        if len(values)!=1 or re.fullmatch(r'Bearer [A-Za-z0-9._~+/=-]+',values[0]) is None:
            raise HTTPException(401,'身份凭据格式无效')
        return True
    # Explicit Web handlers select this cookie themselves and validate it with
    # identity(). Unselected legacy cookies must not override that selection.
    if platform and COOKIE in request.cookies:
        return True
    if market_platform_session_selected(request):
        return True
    names=(COOKIE,WEB_COOKIE,OLD_COOKIE)
    if any(name in request.cookies and not request.cookies[name] for name in names):
        raise HTTPException(401,'身份凭据格式无效')
    return any(name in request.cookies for name in names)
