"""Installed, bounded model transport for a discussion attached to one feed post."""

import asyncio
import hashlib
import ipaddress
import json
import re
from datetime import UTC, datetime
from urllib.parse import urlencode

import httpcore
from cryptography.fernet import Fernet
from fastapi import HTTPException

from .fx_provider_parser import approved_target, unique
from .fx_provider_transport import PinnedBackend, resolve
from .notification_security import NotificationSecurity

HOST = "api.deepseek.com"
PATH = "/chat/completions"


class FeedModel:
    def __init__(self, db):
        self.db = db

    def target(self, owner_id, target_id, purpose="feed.discussion"):
        rows = [
            row
            for row in self.db.settings.feed_model_targets
            if row.get("id") == target_id and row.get("ownerId") == owner_id
        ]
        if len(rows) != 1:
            raise HTTPException(503, "帖子讨论模型尚未安装")
        raw = rows[0]
        try:
            if (
                raw["approvedAccess"] is not True
                or str(raw["instanceId"]) != str(self.db.settings.instance_id)
                or purpose not in {"feed.discussion", "feed.compose", "feed.translate"}
                or raw["purpose"] != purpose
                or raw["provider"] not in {"deepseek", "openai", "custom", "mymemory"}
                or (raw["provider"]=="mymemory" and raw.get("host","api.mymemory.translated.net")!="api.mymemory.translated.net")
                or (
                    raw["provider"] == "mymemory"
                    and (purpose != "feed.translate" or raw.get("model") != "mymemory")
                )
                or not isinstance(raw["licenseRevision"], str)
                or not raw["licenseRevision"]
                or datetime.fromisoformat(raw["expiresAt"]) <= datetime.now(UTC)
                or not re.fullmatch(r"[A-Za-z0-9._-]{1,120}", raw["model"])
                or (
                    raw["provider"] != "mymemory"
                    and (
                        not isinstance(raw.get("credentialCiphertext"), str)
                        or not raw["credentialCiphertext"]
                    )
                )
                or not isinstance(raw["addresses"], list)
                or not raw["addresses"]
                or (raw['provider']=='mymemory' and any(not ipaddress.ip_address(value).is_global for value in raw['addresses']))
            ):
                raise ValueError()
            if raw['provider']!='mymemory':
                from .feed_model_chat import endpoint
                endpoint(raw)
            fingerprint = hashlib.sha256(
                json.dumps(raw, sort_keys=True, separators=(",", ":")).encode()
            ).hexdigest()
        except (KeyError, ValueError, TypeError):
            raise HTTPException(503, "帖子讨论模型的许可或固定目标不可用") from None
        return {**raw, "fingerprint": fingerprint, "expiry": raw["expiresAt"]}

    def available(self, owner_id):
        result = []
        for raw in self.db.settings.feed_model_targets:
            try:
                row = self.target(owner_id, raw.get("id"), purpose=raw.get("purpose"))
            except HTTPException:
                continue
            result.append(
                {
                    key: row[key]
                    for key in ("id", "provider", "model", "purpose", "licenseRevision", "expiresAt")
                }
            )
        return result

    async def memory(self, target, context):
        if isinstance(context, dict):
            context = context.get("messages")
        users = (
            [v["content"] for v in context if isinstance(v, dict) and v.get("role") == "user"]
            if isinstance(context, list)
            else []
        )
        if len(users) != 1:
            raise HTTPException(400, "翻译必须对应一条原帖")
        originals = json.loads(users[0])
        if (
            not isinstance(originals, list)
            or len(originals) != 1
            or not isinstance(originals[0].get("text"), str)
        ):
            raise HTTPException(400, "翻译必须对应一条原帖")
        post = originals[0]
        text = post["text"]
        if not text or len(text.encode("utf-8")) > 500 or len(text.encode("utf-16-le")) // 2 > 480:
            raise HTTPException(413, "原帖超过MyMemory完整翻译预算，保留原文")
        host = "api.mymemory.translated.net"
        path = "/get"
        url = "https://" + host + path + "?" + urlencode({"q": text, "langpair": "en|zh-CN"})
        approval = {
            "target": ["https", host, 443, path],
            "addresses": target["addresses"],
            "allow_plaintext": False,
        }
        result=None;raw=bytearray()
        try:
            async with asyncio.timeout(10):
                pins=approved_target(url,approval,await resolve(host,443))
                async with httpcore.AsyncConnectionPool(network_backend=PinnedBackend(host,443,pins[0]),retries=0,max_connections=1)as pool:
                    async with pool.stream("GET",url,headers={"Accept":"application/json","Accept-Encoding":"identity"},extensions={"timeout":{"connect":5,"read":8,"write":5,"pool":5}})as response:
                        result={"raw":b"","status":response.status,"text":None,"complete":False,"bodyComplete":False,
                            "requestedModel":"mymemory","responseModel":"mymemory","licenseRevision":target["licenseRevision"],"fingerprint":target["fingerprint"]}
                        async for chunk in response.aiter_stream():
                            left=262144-len(raw);raw.extend(chunk[:left])
                            if len(chunk)>left:break
                        else:result['bodyComplete']=True
        except (Exception,asyncio.CancelledError):
            if result is None:raise
        result['raw']=bytes(raw)
        if result['status']==200 and result['bodyComplete']:
            try:translated=memory_translation(result['raw'],post)
            except (ValueError,TypeError,KeyError):translated=None
            if translated:result.update(text=translated,complete=True)
        return result

    async def complete(self, target, context, *, structured=False):
        current=self.target(target['ownerId'],target['id'],purpose=target['purpose'])
        if current['fingerprint']!=target['fingerprint']:raise HTTPException(409,'帖子模型来源已变化，请核对原请求')
        async with self.db.connection()as conn:
            from .fx_reference import external_delivery_blocked
            user=await(await conn.execute('SELECT active FROM users WHERE id=%s',(current['ownerId'],))).fetchone()
            if not user or not user['active']:raise HTTPException(403,'账户不可用')
            if await external_delivery_blocked(conn):raise HTTPException(503,'恢复副本尚未授权外部讨论')
        if current['provider']=='mymemory':return await self.memory(current,context)
        messages=context.get('messages')if isinstance(context,dict)else context
        try:
            secret=json.loads(Fernet(NotificationSecurity(self.db).existing_key()).decrypt(current['credentialCiphertext'].encode()))
            token=secret['password']
            if secret['kind']!='feed-model:'+current['id']or str(secret['instance'])!=str(self.db.settings.instance_id)or not isinstance(token,str)or not token or any(c in token for c in '\r\n\0'):raise ValueError()
        except Exception:raise HTTPException(503,'帖子模型凭据不可用')from None
        from .feed_model_chat import complete
        return await complete(current,messages,token,structured)


def memory_translation(raw, post):
    try:
        value = json.loads(raw, object_pairs_hook=unique)
        text = value["responseData"]["translatedText"]
        if (
            value.get("responseStatus") != 200
            or not isinstance(text, str)
            or not text.strip()
            or len(text) > 20000
        ):
            return None
        return json.dumps(
            [
                {
                    "personId": post["personId"],
                    "platformPostId": post["platformPostId"],
                    "textZh": text.strip(),
                }
            ],
            ensure_ascii=False,
        )
    except (ValueError, TypeError, KeyError):
        return None
