"""Shared safe HTML renderer for plain-text mail templates and administrator previews."""

import re
from functools import lru_cache
from pathlib import Path
from string import Template

from .mail_template_model import COMMON, PRICE, render_text


def escape(value):
    return str(value).replace('&', '&amp;').replace('<', '&lt;').replace('>', '&gt;').replace('"', '&quot;').replace("'", '&#39;')


@lru_cache(maxsize=1)
def layout():
    return Template(Path(__file__).with_name('mail_template_layout.html').read_text())


def dark(selector, css):
    parts = [item.strip() for item in selector.split(',')]

    def scope(prefix):
        return ','.join(prefix + ' ' + part for part in parts)

    return scope('html.dark') + ',' + scope('html[data-theme=dark]') + '{' + css + '}@media (prefers-color-scheme:dark){' + scope('html:not([data-theme=light])') + '{' + css + '}}'


DARK_CSS = ''.join(dark(selector, css) for selector, css in (
    ('body', 'background:#18181a!important;color:#ececee!important'),
    ('.mail-title', 'color:#ffffff!important'),
    ('.mail-copy,.mail-token,.mail-meta', 'color:#ececee!important'),
    ('.mail-copy a', 'color:#9ec1ff!important'),
    ('.mail-value', 'background:#2c2c2e!important;border-color:#3a3a3c!important'),
    ('.mail-value-label,.mail-code,.mail-alert-price', 'color:#ffffff!important'),
    ('.mail-alert-price span,.mail-meta', 'color:#a1a1a6!important'),
    ('.mail-signature', 'color:#a1a1a6!important;border-color:#3a3a3c!important'),
    ('.mail-signature p', 'color:#f2f2f3!important'),
))


def render_mail(template, values, banner_src='cid:alcor-mail-banner'):
    text = render_text(template, values)
    price_alert = template['id'] == 'price_alert'
    allowed = COMMON | (PRICE if price_alert else set())
    tones = dict(zip(
        ('link', 'muted', 'value', 'action', 'hint', 'body', 'title', 'panel', 'border', 'signature', 'divider', 'signatureInk'),
        ('#333333', '#777777', '#161616', '#161616', '#777777', '#333333', '#111111', '#f5f5f5', '#e7e7e7', '#777777', '#e5e5e5', '#333333') if price_alert else
        ('#137f78', '#4e6d66', '#163b33', '#143f36', '#63716c', '#35443f', '#172f29', '#f1f8f4', '#dcece3', '#5d7068', '#e5ede8', '#213e34'), strict=True,
    ))

    def fill(field):
        return re.sub(r'\{\{([A-Za-z][A-Za-z0-9]*)\}\}', lambda m: str(values.get(m[1], '')) if m[1] in allowed else m[0], field)

    def field(value):
        return escape(fill(value)).replace('\n', '<br>')

    email = escape(values['email'])
    paragraph = field(template['body'])
    if email:
        paragraph = paragraph.replace(email, f'<a href="mailto:{email}" style="color:{tones["link"]};text-decoration:underline">{email}</a>')
    label = f'<div class="mail-value-label" style="font-size:15px;line-height:1.5;color:{tones["muted"]};margin-bottom:20px">{field(template["valueLabel"])}</div>'
    if price_alert:
        value = f'{label}<div class="mail-alert-price" style="font-size:36px;line-height:1.25;font-weight:600;color:{tones["value"]};font-variant-numeric:tabular-nums;overflow-wrap:anywhere">{escape(values.get("currentPrice") or "—")}<span style="font-size:14px;font-weight:400;margin-left:7px;color:{tones["muted"]}">{escape(values.get("currency") or "")}</span></div><div style="font-size:14px;line-height:1.6;color:{tones["muted"]};margin-top:10px">提醒价 {escape(values.get("targetPrice") or "—")}</div>'
    elif template['kind'] == 'code':
        value = f'{label}<div class="mail-code" style="font-size:46px;line-height:1.25;letter-spacing:8px;font-weight:600;color:{tones["value"]};font-variant-numeric:tabular-nums">{values["code"]}</div>'
    elif template['kind'] == 'link':
        value = f'<a href="{escape(values["url"])}" style="display:inline-block;background:{tones["action"]};border-radius:10px;padding:15px 30px;font-size:17px;line-height:1.4;font-weight:600;color:#fff;text-decoration:none">{field(template["valueLabel"])}</a>'
    else:
        value = f'<div style="font-size:22px;line-height:1.5;font-weight:600;color:{tones["value"]}">{field(template["valueLabel"])}</div>'
    token = f'<p class="mail-token" style="font-size:13px;line-height:1.8;word-break:break-all;margin-top:24px;color:{tones["hint"]}">也可在 Alcor App 的邮箱验证页粘贴一次性凭证：<br>{escape(values["nativeToken"])}</p>' if values.get('nativeToken') else ''
    greeting = '' if price_alert else f'<p class="mail-copy" style="overflow-wrap:anywhere;font-size:17px;line-height:1.85;margin:0 0 18px">{field(template["greeting"])}</p>'
    metadata = f'<p class="mail-meta" style="font-size:13px;line-height:1.7;color:{tones["muted"]};margin:18px 0 0;text-align:center">{escape(" · ".join(v for v in (values.get("session"), values.get("triggerTime")) if v))}</p>' if price_alert else ''
    closing = '' if price_alert else field(template['closing']).strip()
    signature_text = field(template['signature']).strip()
    signature = ''
    if closing or signature_text:
        if price_alert:
            signature = f'<div class="mail-signature" style="font-size:14px;line-height:1.8;margin-top:30px;padding-top:20px;border-top:1px solid {tones["divider"]};color:{tones["signature"]}">{signature_text}</div>'
        else:
            closing_html = f'<p style="margin:0{" 0 8px" if signature_text else ""}">{closing}</p>' if closing else ''
            signature = f'<div class="mail-signature" style="font-size:15px;line-height:1.8;margin-top:38px;padding-top:24px;border-top:1px solid {tones["divider"]};color:{tones["signature"]}">{closing_html}<p class="mail-signature-name" style="margin:0;font-weight:600;color:{tones["signatureInk"]}{"" if signature_text else ";display:none"}">{signature_text}</p></div>'
    html = layout().substitute(dark_css=DARK_CSS, body_color=tones['body'], title_color=tones['title'], banner=escape(banner_src), banner_alt='Alcor' if price_alert else 'Alcor 账户安全', title=field(template['title']), greeting=greeting, paragraph=paragraph, value=value, token=token, metadata=metadata, signature=signature, panel_color=tones['panel'], border_color=tones['border'])
    return {**text, 'html': html}
