"""Original-person JSON adapter; never interprets news RSS as a person's post."""

import json
from datetime import UTC, datetime

from .feed_parse import LIMIT, clean, public_url, published


def parse_people(raw, target):
    if len(raw) > LIMIT or target.get("personId") not in {"trump", "duan"}:
        raise ValueError("person_source_invalid")
    rows = original_rows(raw, target)
    if not isinstance(rows, list) or len(rows) > 10000:
        raise ValueError("person_posts_invalid")
    posts = []
    for row in rows:
        if not isinstance(row, dict):
            continue
        rid = row.get("id")
        text = row.get("text")
        url = public_url(row.get("originalUrl"))
        if (
            not isinstance(rid, (str, int))
            or isinstance(rid, bool)
            or not str(rid)
            or not isinstance(text, str)
            or (not text.strip() and not row.get("images") and not row.get("quote"))
            or not url
        ):
            continue
        if len(text.encode("utf-16-le")) > 40000:
            continue
        date = row.get("date")
        at = published(date, datetime.now(UTC)) if isinstance(date, str) else None
        images = (
            [u for v in row.get("images", []) if (u := public_url(v))]
            if isinstance(row.get("images", []), list)
            else []
        )
        original = {
            "person": {"id": target["personId"]},
            "platformPostId": str(rid),
            "originalUrl": url,
            "text": text,
            "publishedAtRaw": date,
            "sourceTargetId": target["id"],
            "translationState": "unavailable",
            "sourceFields": {
                k: row[k]
                for k in (
                    "archiveUrl",
                    "quote",
                    "categories",
                    "replyTo",
                    "reply",
                    "replies",
                    "likes",
                    "images",
                    "comments",
                )
                if k in row
            },
        }
        # Existing source translation is evidence only when its installation explicitly permits it.
        if (
            target.get("translationPublicDisplay") is True
            and isinstance(row.get("textZh"), str)
            and row["textZh"].strip()
        ):
            original.update(
                textZh=row["textZh"],
                translationState="source_provided",
                translationAuthority="installed_source_translation",
            )
        posts.append(
            {
                "title": clean(text, 300) or "原帖媒体",
                "icon": "note",
                "segments": [{"type": "text", "text": text or "原帖含媒体或引用"}],
                "sources": [
                    {
                        "id": "person-" + str(rid),
                        "title": clean(text, 300) or "原帖媒体",
                        "url": url,
                        "publisher": target["personId"],
                        "publishedAt": at,
                        "excerpt": clean(text, 16000),
                        "media": [{"type": "image", "url": url, "alt": ""} for url in images],
                    }
                ],
                "media": [{"type": "image", "url": url, "alt": ""} for url in images],
                "publishedAt": at,
                "original": original,
            }
        )
    return {
        "posts": posts,
        "coverage": {
            "sourceItemCount": len(rows),
            "processedItems": len(rows),
            "acceptedItems": len(posts),
            "partial": len(posts) != len(rows),
            "rejectedItems": len(rows) - len(posts),
            "limit": 10000,
        },
    }


def original_rows(raw, target):
    """Decode only the installed original site's protocol, without discovery requests."""
    import re
    from html.parser import HTMLParser
    from urllib.parse import urljoin

    class Archive(HTMLParser):
        def __init__(self):
            super().__init__(convert_charrefs=True)
            self.rows = []
            self.row = None
            self.depth = 0
            self.content = 0

        def handle_starttag(self, tag, attrs):
            a = dict(attrs)
            classes = a.get("class", "").split()
            if tag == "div":
                if "status" in classes:
                    if self.row:
                        self.rows.append(self.row)
                    self.row = {"text": "", "date": None, "images": []}
                    self.depth = 1
                    self.content = 0
                elif self.row:
                    self.depth += 1
                    if "status__content" in classes:
                        self.content = self.depth
            if not self.row:
                return
            archive = a.get("data-status-url")
            if archive:
                self.row["archiveUrl"] = urljoin("https://trumpstruth.org/statuses/", archive)
            href = a.get("href", "")
            if href.startswith("https://truthsocial.com/@realDonaldTrump/"):
                self.row["originalUrl"] = href
            if tag == "time" and a.get("datetime"):
                self.row["date"] = a["datetime"]
            if tag == "img" and a.get("src"):
                self.row["images"].append(urljoin(target["url"], a["src"]))
            if "status-attachment__link" in classes and href:
                self.row["images"].append(urljoin(target["url"], href))
            if tag in ("br", "p") and self.content:
                self.row["text"] += "\n"

        def handle_data(self, data):
            if self.row and self.content:
                self.row["text"] += data

        def handle_endtag(self, tag):
            if tag == "div" and self.row:
                if self.depth == self.content:
                    self.content = 0
                self.depth -= 1
                if self.depth == 0:
                    self.rows.append(self.row)
                    self.row = None

    if target["provider"] == "trump-archive-html":
        parser = Archive()
        parser.feed(raw.decode("utf-8", errors="strict"))
        if parser.row:
            parser.rows.append(parser.row)
        for row in parser.rows:
            archive = row.get("archiveUrl", "").rstrip("/").split("/")[-1]
            truth = row.get("originalUrl", "").rstrip("/").split("/")[-1]
            row["id"] = archive if re.fullmatch(r"\d{4,}", archive) else truth if truth.isdigit() else None
        return parser.rows
    value = json.loads(raw)
    if target["provider"] != "xueqiu-status-json":
        return value.get("posts") if isinstance(value, dict) else value
    if not isinstance(value, dict) or not isinstance(value.get("statuses"), list):
        raise TypeError("xueqiu_statuses_missing")
    rows = []

    def images(item):
        result = []

        def collect(v):
            if isinstance(v, str):
                for u in re.split(r"[,\s]+", v):
                    u = "https:" + u if u.startswith("//") else u
                    if public_url(u) and u not in result:
                        result.append(u)
            elif isinstance(v, list):
                for x in v:
                    collect(x)
            elif isinstance(v, dict):
                for key in ("url", "src", "pic", "original", "large", "original_pic"):
                    if key in v:
                        collect(v[key])
                        break

        for key in (
            "original_pic",
            "image_info_list",
            "pics",
            "pic_urls",
            "bmiddle_pic",
            "cover_pic",
            "pic",
            "firstImg",
            "thumbnail_pic",
        ):
            collect(item.get(key))
        for info in item.get("image_info_list", []) or []:
            if isinstance(info, dict) and isinstance(info.get("filename"), str):
                collect("https://xqimg.imedao.com/" + info["filename"])
        for u in re.findall(
            r"<img[^>]+src=[\'\"]([^\'\"]+)",
            str(item.get("text") or item.get("description") or ""),
            re.IGNORECASE,
        ):
            collect(u)
        return result[:9]

    for item in value["statuses"]:
        if not isinstance(item, dict):
            continue
        user = item.get("user") or {}
        if isinstance(user, dict) and user.get("id") is not None and str(user["id"]) != "1247347556":
            continue
        rid = item.get("id")
        date = item.get("created_at")
        if isinstance(date, (int, float)) and not isinstance(date, bool):
            try:
                date = datetime.fromtimestamp(date / 1000, UTC).isoformat()
            except (ValueError, OverflowError, OSError):
                date = None
        text = clean(item.get("text") or item.get("description") or item.get("title") or "", 20000)
        row = {
            "id": rid,
            "date": date,
            "text": text,
            "originalUrl": f"https://xueqiu.com/1247347556/{rid}",
            "images": images(item),
        }
        for key, source in (("likes", "like_count"), ("replies", "reply_count")):
            if item.get(source) is not None:
                row[key] = item[source]
        for key in (
            "reply_comment",
            "reply_status",
            "comment",
            "retweeted_status",
            "retweet_status",
            "quoted_status",
        ):
            quote = item.get(key)
            if not isinstance(quote, dict):
                continue
            qt = clean(quote.get("text") or quote.get("description") or quote.get("title") or "", 20000)
            if not qt:
                continue
            qu = quote.get("user") or {}
            row["quote"] = {
                "name": qu.get("screen_name") or qu.get("name") or "原动态",
                "text": qt,
                "images": images(quote),
            }
            if qu.get("id") and quote.get("id"):
                row["quote"]["url"] = f"https://xueqiu.com/{qu['id']}/{quote['id']}"
            break
        reply = re.match(r"\s*回复\s*@([^\s:：]{1,40})\s*[:：]", str(item.get("text") or ""))
        if reply:
            row.update(reply=True, replyTo=reply[1])
        rows.append(row)
    return rows
