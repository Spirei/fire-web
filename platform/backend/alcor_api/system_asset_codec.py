"""Original shared-image rules; SVG presentation normalization keeps raw bytes separate."""

import hashlib
import re
from xml.parsers import expat

from fastapi import HTTPException

KINDS = {
    "ico": (["jpg", "jpeg", "png", "gif", "webp", "ico", "svg"], 1048576),
    "background": (["jpg", "jpeg", "png", "gif", "webp"], 10485760),
    "logo": (["jpg", "jpeg", "png", "gif", "webp", "svg"], 2097152),
    "login": (["jpg", "jpeg", "png", "gif", "webp"], 10485760),
    "asset": (["jpg", "jpeg", "png", "gif", "webp", "svg"], 2097152),
}
FOLDERS = {"market", "flag", "crypto", "metal", "stock", "broker", "group", "icon", "card"}
MIME = {
    "jpg": "image/jpeg",
    "jpeg": "image/jpeg",
    "png": "image/png",
    "gif": "image/gif",
    "webp": "image/webp",
    "ico": "image/x-icon",
    "svg": "image/svg+xml",
}
ALLOWED = {
    "svg",
    "g",
    "defs",
    "symbol",
    "use",
    "path",
    "rect",
    "circle",
    "ellipse",
    "line",
    "polyline",
    "polygon",
    "text",
    "tspan",
    "title",
    "desc",
    "linearGradient",
    "radialGradient",
    "stop",
    "clipPath",
    "mask",
    "pattern",
    "filter",
    "feGaussianBlur",
    "feOffset",
    "feBlend",
    "feColorMatrix",
    "feComponentTransfer",
    "feFuncR",
    "feFuncG",
    "feFuncB",
    "feFuncA",
    "feMerge",
    "feMergeNode",
    "feFlood",
    "feComposite",
    "feDropShadow",
}
SVG_NS = "http://www.w3.org/2000/svg"
XML_NS = {
    "http://www.w3.org/2000/xmlns/",
    "http://www.w3.org/XML/1998/namespace",
    "http://www.w3.org/1999/xlink",
}


def strip_doctype(text):
    while True:
        match = re.search("<!doctype", text, re.IGNORECASE)
        if not match:
            return text
        depth = 0
        end = None
        for i in range(match.start(), len(text)):
            c = text[i]
            if c == "[":
                depth += 1
            elif c == "]":
                depth -= 1
            elif c == ">" and depth == 0:
                end = i + 1
                break
        if end is None:
            return text
        text = text[: match.start()] + text[end:]


def svg_root(text):
    text = text.removeprefix("\ufeff")
    while True:
        text = text.lstrip()
        if text.startswith("<!--"):
            end = text.find("-->", 4)
            if end < 0:
                return None
            text = text[end + 3 :]
            continue
        if re.match(r"<\?xml(?:\s|\?>)", text, re.IGNORECASE):
            end = text.find("?>", 5)
            if end < 0:
                return None
            text = text[end + 2 :]
            continue
        if re.match("<!doctype", text, re.IGNORECASE):
            cleaned = strip_doctype(text)
            if cleaned == text:
                return None
            text = cleaned
            continue
        return text


def local_urls(value):
    for match in re.finditer(r"url\s*\(", value, re.IGNORECASE):
        end = value.find(")", match.end())
        if end < 0:
            return False
        inner = value[match.end() : end].strip()
        if inner.startswith(('"', "'")):
            if len(inner) < 2 or inner[-1] != inner[0]:
                return False
            inner = inner[1:-1]
        if not re.fullmatch("#[A-Za-z0-9_.:-]+", inner):
            return False
    return True


def safe_value(value):
    return (
        "\\" not in value
        and not re.search(r"javascript:|vbscript:|@import|expression\s*\(", value, re.IGNORECASE)
        and local_urls(value)
    )


def safe_svg(text):
    cleaned = strip_doctype(text)
    parser = expat.ParserCreate(namespace_separator="}")

    def tag(name, attributes):
        uri, local = name.rsplit("}", 1) if "}" in name else ("", name)
        if uri and uri != SVG_NS or local not in ALLOWED:
            raise ValueError()
        for attribute_name, value in attributes.items():
            uri, local = attribute_name.rsplit("}", 1) if "}" in attribute_name else ("", attribute_name)
            key = local.lower()
            value = value.strip()
            if key.startswith("on") or uri and uri not in XML_NS or not safe_value(value):
                raise ValueError()
            if key in ("href", "src", "poster") and not re.fullmatch("#[A-Za-z0-9_.:-]+", value):
                raise ValueError()

    def namespace(prefix, uri):
        if uri and not safe_value(uri):
            raise ValueError()

    def instruction(target, data):
        if target.lower() != "xml":
            raise ValueError()

    def no_doctype(*args):
        raise ValueError()

    parser.StartElementHandler = tag
    parser.StartNamespaceDeclHandler = namespace
    parser.ProcessingInstructionHandler = instruction
    parser.StartDoctypeDeclHandler = no_doctype
    parser.ExternalEntityRefHandler = lambda *args: 0
    try:
        parser.Parse(cleaned, True)
    except (expat.ExpatError, ValueError, RecursionError):
        return False
    lowered = cleaned.lower()
    denied = (
        "<script",
        "<foreignobject",
        "<object",
        "<embed",
        "<iframe",
        "<link",
        "<meta",
        "<a ",
        "<image",
        "<animate",
        "<set",
        "<animatetransform",
        "<!doctype",
        "<?xml-stylesheet",
        "onerror",
        "onload",
        "onclick",
        "onmouse",
        "onfocus",
        "onblur",
        "onchange",
        "onsubmit",
        "onkey",
        "onpointer",
        "onauxclick",
        "ondrag",
        "ondrop",
        "onwheel",
        "oncopy",
        "onpaste",
        "oncut",
        "oninput",
        "onselect",
        "javascript:",
        "vbscript:",
    )
    if (
        any(word in lowered for word in denied)
        or re.search(r"@import\b|expression\s*\(|-moz-binding\b", lowered)
        or not local_urls(lowered)
    ):
        return False
    for match in re.finditer(r"\b(?:href|xlink:href)\s*=\s*([\"\'])(.*?)\1", lowered, re.DOTALL):
        if not match[2].strip().startswith("#") or len(match[2].strip()) < 2:
            return False
    return not re.search(r"\b(?:src|poster)\s*=\s*[\"\']", lowered)


def image_bytes(raw, extension):
    ext = extension.lower()
    expected = "jpg" if ext == "jpeg" else ext
    actual = (
        "png"
        if raw.startswith(b"\x89PNG\r\n\x1a\n")
        else "jpg"
        if raw.startswith(b"\xff\xd8\xff")
        else "gif"
        if raw[:6] in (b"GIF87a", b"GIF89a")
        else "webp"
        if len(raw) >= 12 and raw[:4] == b"RIFF" and raw[8:12] == b"WEBP"
        else "ico"
        if raw[:4] == b"\x00\x00\x01\x00"
        else None
    )
    if actual:
        if actual != expected:
            raise HTTPException(400, "文件内容与图片格式不匹配或包含不安全内容")
        return raw, MIME[actual]
    text = raw.decode("utf8", "replace")
    root = svg_root(text)
    if not actual and root and re.match(r"<svg(?:\s|>)", root, re.IGNORECASE):
        actual = "svg"
    if actual != expected or actual == "svg" and not safe_svg(text):
        raise HTTPException(400, "文件内容与图片格式不匹配或包含不安全内容")
    if actual != "svg":
        return raw, MIME[actual]
    normalized = re.sub(
        r"<!--\s*by\s+tradingview\s*-->", "<!-- by alcor -->", text, flags=re.IGNORECASE
    ).removeprefix("\ufeff")
    normalized = re.sub(r"<\?xml[^>]*\?>", "", normalized, flags=re.IGNORECASE)
    normalized = strip_doctype(normalized)
    match = re.search(r"<svg(?:\s|>)", normalized, re.IGNORECASE)
    body = normalized[match.start() :].strip() if match else normalized.strip()
    return ("<!-- by alcor -->\n" + body).encode(), MIME["svg"]


def asset_name(name, code, market, folder, ext):
    clean = lambda v: re.sub(r"^[.]+", "", re.sub(r"[^a-zA-Z0-9._-]", "", str(v)))[:64]
    key = clean((market or code) if folder == "market" else code)
    if folder in ("flag", "icon"):
        key = key.lower()
    if key:
        return key + "." + ext
    ascii_name = clean(re.sub(r"\s+", "-", name)) if re.fullmatch(r"[a-zA-Z0-9._ -]+", name) else ""
    return (
        (ascii_name or (clean(folder) or "asset") + "-" + hashlib.sha256(name.encode()).hexdigest()[:12])
        + "."
        + ext
    )
