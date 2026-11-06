"""Bounded RSS/Atom parsing. Originals, absent dates and skipped items stay explicit."""

import html
import ipaddress
import re
from datetime import UTC, datetime, timedelta
from email.utils import parsedate_to_datetime
from urllib.parse import urljoin, urlsplit
from xml.etree import ElementTree as ET

LIMIT = 1_500_000


def public_url(value, base=""):
    try:
        value = urljoin(base, value.strip())
        parsed = urlsplit(value)
        if (
            parsed.scheme != "https"
            or parsed.username
            or parsed.password
            or not parsed.hostname
            or parsed.port not in (None, 443)
        ):
            return None
        host = parsed.hostname.lower()
        if (
            host in {"localhost", "localhost.localdomain"}
            or "." not in host
            or host.endswith((".local", ".internal", ".localhost", ".lan"))
        ):
            return None
        try:
            if not ipaddress.ip_address(host).is_global:
                return None
        except ValueError:
            pass
        return value
    except (ValueError, AttributeError):
        return None


def clean(value, limit):
    text = re.sub(r"\s+", " ", html.unescape(re.sub(r"<[^>]*>", " ", value or ""))).strip()
    return text.encode("utf-16-le")[: limit * 2].decode("utf-16-le", errors="ignore")


def local(tag):
    return tag.rsplit("}", 1)[-1].split(":")[-1]


def text(node):
    return "".join(node.itertext())


def published(value, now):
    try:
        try:
            when = datetime.fromisoformat(value)
        except ValueError:
            when = parsedate_to_datetime(value)
        if when.tzinfo is None or when > now + timedelta(seconds=60):
            return None
        return when.astimezone(UTC).isoformat()
    except (ValueError, TypeError, OverflowError):
        return None


def parse_feed(raw, base_url, name="", *, now=None):
    now = now or datetime.now(UTC)
    if (
        not isinstance(raw, bytes)
        or not 0 < len(raw) <= LIMIT
        or b"<!DOCTYPE" in raw.upper()
        or b"<!ENTITY" in raw.upper()
    ):
        raise ValueError("feed_document_unsafe_or_oversized")
    try:
        root = ET.fromstring(raw)
    except ET.ParseError as exc:
        raise ValueError("feed_xml_invalid") from exc
    if local(root.tag) not in {"rss", "feed", "RDF"}:
        raise ValueError("feed_document_not_rss_atom")
    title = ""
    channel = next((n for n in root if local(n.tag) == "channel"), root)
    for node in channel:
        if local(node.tag) == "title":
            title = clean(text(node), 100)
            break
    entries = [n for n in root.iter() if local(n.tag) in {"item", "entry"}]
    if len(entries) > 10000:
        raise ValueError("feed_item_budget_exceeded")
    values = []
    skipped = 0
    for index, node in enumerate(entries[:50]):
        fields = {}
        media = []
        link = ""
        for child in node:
            tag = local(child.tag)
            if (
                tag == "link"
                and child.attrib.get("href")
                and child.attrib.get("rel", "alternate") == "alternate"
            ):
                link = child.attrib["href"]
            elif tag == "link":
                link = text(child)
            if tag in {"title", "pubDate", "published", "description", "summary", "encoded", "content"}:
                fields.setdefault(tag, text(child))
            if tag in {"thumbnail", "content", "enclosure"} and child.attrib.get("url"):
                url = public_url(child.attrib["url"], base_url)
                kind = child.attrib.get("type", "")
                if url and (tag == "thumbnail" or kind.startswith("image/")):
                    media.append({"type": "image", "url": url})
                elif (
                    url and kind.startswith("video/") and re.search(r"\.(mp4|webm)(\?|$)", url, re.IGNORECASE)
                ):
                    media.append({"type": "video", "url": url})
        url = public_url(link, base_url)
        headline = clean(fields.get("title", ""), 300)
        if not url or not headline:
            skipped += 1
            continue
        raw_date = fields.get("pubDate", fields.get("published", ""))
        values.append(
            {
                "id": "r" + str(index),
                "title": headline,
                "url": url,
                "publisher": (name or title or urlsplit(base_url).hostname or "")[:100],
                "publishedAt": published(raw_date, now) if raw_date else None,
                "publishedAtRaw": raw_date or None,
                "excerpt": clean(
                    fields.get("encoded")
                    or fields.get("content")
                    or fields.get("description")
                    or fields.get("summary")
                    or "",
                    16000,
                ),
                "media": media[:20],
            }
        )
    return {
        "title": title or name,
        "sources": values,
        "coverage": {
            "sourceItemCount": len(entries),
            "processedItems": min(50, len(entries)),
            "skippedItems": skipped,
            "partial": len(entries) > 50,
            "limit": 50,
        },
        "protocol": "rss-atom-bounded-v1",
    }
