"""Installed, owner/licence/instance-bound screenshot OCR; no default targets."""

import asyncio
import base64
import hashlib
import io
import ipaddress
import json
import re
from datetime import UTC, datetime
from decimal import Decimal, InvalidOperation
from uuid import UUID, uuid5

import httpcore
from cryptography.fernet import Fernet
from fastapi import HTTPException
from PIL import Image

from .fx_provider_parser import approved_target, unique
from .fx_provider_transport import PinnedBackend, resolve
from .notification_security import NotificationSecurity
from .portfolio_records import ALIASES

PROMPT = "识别截图股票行，仅输出名称|代码|数量|成本|现价|涨跌幅，每行一只。缺失字段留空；禁止补充、推测代码或数量，不输出标题说明。"


def hashed_target(target):
    return hashlib.sha256(json.dumps(target, sort_keys=True).encode()).hexdigest()


def identity(code, market=""):
    code = str(code or "").strip().upper()
    market = str(market or "").strip().upper()
    market = ALIASES.get(
        market,
        market
        if market
        in {
            "US",
            "HK",
            "CN",
            "JP",
            "KR",
            "SG",
            "UK",
            "DE",
            "FR",
            "AU",
            "CA",
            "IN",
            "TW",
            "BR",
            "ASSET",
            "OTHER",
        }
        else "",
    )
    match = (
        re.fullmatch(r"(US|HK|CN|SH|SZ|BJ|SG|JP|KR|UK)[.:]([A-Z0-9._-]+)", code)
        or re.fullmatch(r"(HK)(\d{1,5})", code)
        or re.fullmatch(r"(SH|SZ|BJ)(\d{6})", code)
    )
    suffix = re.fullmatch(r"(.+)\.(US|HK|CN|SG|JP|KR|UK)", code)
    explicit = ALIASES.get(match[1], match[1]) if match else suffix[2] if suffix else ""
    if market and explicit and market != explicit:
        raise HTTPException(400, "股票市场与代码前后缀不一致")
    if match:
        code = match[2]
    elif suffix:
        code = suffix[1]
    market = market or explicit
    if not re.fullmatch(r"[A-Z0-9][A-Z0-9._-]{0,39}", code):
        return "", market
    if market == "HK" and code.isdigit() and len(code) <= 5:
        code = code.zfill(5)
    if market == "US":
        code = re.sub(r"\.(AM|N|OQ|PS|K)$", "", code)
    if market == "JP":
        code = re.sub(r"\.T$", "", code)
    if market == "KR":
        code = re.sub(r"\.(KS|KQ)$", "", code)
    return code, market


def numeric(value):
    if value is None or value == "":
        return None
    value = re.sub(r"[,，¥$€£%]", "", str(value)).replace("HK", "")
    value = re.sub(r"[－—–−]", "-", value).strip()
    try:
        number = Decimal(value)
        return format(number, "f") if number.is_finite() else None
    except InvalidOperation:
        return None


def text_rows(raw):
    rows = []
    for line in raw.splitlines():
        if not line.strip() or line.lstrip().startswith("```"):
            continue
        # Unlike whitespace fallback, a pipe preserves genuinely missing fields.
        fields = [part.strip() for part in line.split("|")]
        if len(fields) != 6:
            continue
        name, code, qty, cost, price, change = fields
        if not name and not code:
            continue
        rows.append(
            {
                "name": name,
                "code": code,
                "market": "",
                "qty": numeric(qty),
                "cost": numeric(cost),
                "price": numeric(price),
                "changePct": numeric(change),
                "recognitionAuthority": "provider_ocr_unconfirmed",
                "marketInferred": False,
            }
        )
    return rows[:100]


def image_mime(raw):
    try:
        if not 0 < len(raw) <= 8 * 1024 * 1024:
            raise ValueError()
        with Image.open(io.BytesIO(raw)) as image:
            if (
                image.format not in {"JPEG", "PNG", "GIF", "WEBP"}
                or image.width * image.height > 25_000_000
                or getattr(image, "n_frames", 1) != 1
            ):
                raise ValueError()
            fmt = image.format
            image.verify()
        return {"JPEG": "image/jpeg", "PNG": "image/png", "GIF": "image/gif", "WEBP": "image/webp"}[fmt]
    except Exception as exc:
        raise HTTPException(400, "仅支持单帧且有效的JPG/PNG/GIF/WEBP截图，最大8MiB/2500万像素") from exc


class ImageOCR:
    def __init__(self, db):
        self.db = db

    def target(self, who, target_id):
        rows = [row for row in self.db.settings.record_ocr_targets if row.get("id") == target_id]
        if len(rows) != 1:
            raise HTTPException(503, "截图识别来源尚未安装")
        row = rows[0]
        try:
            if (
                row["ownerId"] != who.id
                or str(row["instanceId"]) != str(self.db.settings.instance_id)
                or row["approvedAccess"] is not True
                or row["purpose"] != "record.screenshot.ocr"
                or row["provider"] not in {"deepseek", "apple-vision"}
            ):
                raise ValueError()
            if datetime.fromisoformat(row["expiresAt"]) <= datetime.now(UTC) or not row["licenseRevision"]:
                raise ValueError()
            if row["provider"] == "apple-vision":
                if row.get("model") != "apple-vision-v1":raise ValueError()
                return row
            if row["model"] not in {"deepseek-flash", "deepseek-v4-flash-vision-exp"}:
                raise ValueError()
            if not row["addresses"] or any(not ipaddress.ip_address(ip).is_global for ip in row["addresses"]):
                raise ValueError()
            if row.get("host") != "api.deepseek.com":
                raise ValueError()
            if not row["credentialCiphertext"]:
                raise ValueError()
        except (KeyError, ValueError, TypeError) as exc:
            raise HTTPException(503, "截图识别来源许可、固定目标或凭据不可用") from exc
        return row

    def available(self, who):
        result = []
        for raw in self.db.settings.record_ocr_targets:
            try:
                target = self.target(who, raw.get("id"))
            except HTTPException:
                continue
            fallback_ids = {value.get("fallbackTargetId") for value in self.db.settings.record_ocr_targets if value.get("ownerId") == who.id}
            result.append({**{k: target[k] for k in ("id", "provider", "model", "licenseRevision", "expiresAt")},
                           "fallbackOnly": target["id"] in fallback_ids,
                           "fallbackTargetId": target.get("fallbackTargetId")})
        return result

    async def recognize_cloud(self, who, target_id, raw):
        capture={"status":None,"raw":bytearray()}
        try:
            return await self._recognize_cloud_io(who,target_id,raw,capture)
        except (httpcore.NetworkError,httpcore.ProtocolError,httpcore.TimeoutException,TimeoutError):
            if capture["status"] is None:raise
            return {"state":"unknown","rows":[],"raw":bytes(capture["raw"]),"status":capture["status"],
                    "complete":False,"reason":"provider_response_incomplete"}

    async def _recognize_cloud_io(self, who, target_id, raw, capture):
        target = self.target(who, target_id)
        mime = image_mime(raw)
        security = NotificationSecurity(self.db)
        try:
            credential = json.loads(
                Fernet(security.existing_key()).decrypt(target["credentialCiphertext"].encode())
            )
            if credential["kind"] != "record-ocr:" + target_id or credential["instance"] != str(
                self.db.settings.instance_id
            ):
                raise ValueError()
            token = credential["password"]
            if not isinstance(token, str) or not token or "\n" in token or "\r" in token:
                raise ValueError()
        except Exception as exc:
            raise HTTPException(503, "截图识别凭据不可用") from exc
        path = "/chat/completions"
        url = "https://api.deepseek.com" + path
        approval = {
            "target": ["https", "api.deepseek.com", 443, path],
            "addresses": target["addresses"],
            "allow_plaintext": False,
        }
        async with asyncio.timeout(90):
            pins = approved_target(url, approval, await resolve("api.deepseek.com", 443))
            payload = json.dumps(
                {
                    "model": target["model"],
                    "messages": [
                        {
                            "role": "user",
                            "content": [
                                {"type": "text", "text": PROMPT},
                                {
                                    "type": "image_url",
                                    "image_url": {
                                        "url": "data:" + mime + ";base64," + base64.b64encode(raw).decode()
                                    },
                                },
                            ],
                        }
                    ],
                    "temperature": 0.1,
                    "max_tokens": 4000,
                },
                ensure_ascii=False,
            ).encode()
            async with (
                httpcore.AsyncConnectionPool(
                    network_backend=PinnedBackend("api.deepseek.com", 443, pins[0]),
                    retries=0,
                    max_connections=1,
                ) as pool,
                pool.stream(
                    "POST",
                    url,
                    headers={"Content-Type": "application/json", "Authorization": "Bearer " + token},
                    content=payload,
                    extensions={"timeout": {"connect": 10, "read": 75, "write": 15, "pool": 5}},
                ) as response,
            ):
                capture["status"]=response.status
                output = capture["raw"]
                async for chunk in response.aiter_stream():
                    remaining=1_000_000-len(output)
                    output.extend(chunk[:remaining])
                    if len(chunk)>remaining:
                        return {"state":"unknown","rows":[],"raw":bytes(output),"status":response.status,
                                "complete":False,"reason":"provider_response_budget"}
                original = bytes(output)
                if response.status != 200:
                    return {
                        "state": "rejected" if 400 <= response.status < 500 else "unknown",
                        "status": response.status,
                        "complete": True,
                        "raw": original,
                        "rows": [],
                        "text": "",
                    }
                try:
                    body = json.loads(original, object_pairs_hook=unique)
                    text = body["choices"][0]["message"]["content"]
                    if not isinstance(text, str):
                        raise TypeError("ocr_response_shape")
                except (ValueError, TypeError, KeyError, IndexError):
                    return {
                        "state": "unknown",
                        "status": 200,
                        "complete": True,
                        "raw": original,
                        "rows": [],
                        "text": "",
                        "reason": "provider_response_shape_unconfirmed",
                    }
                return {
                    "state": "recognized",
                    "status": 200,
                    "complete": True,
                    "raw": original,
                    "rows": text_rows(text),
                    "text": text,
                    "provider": target["provider"],
                    "requestedModel": target["model"],
                    "responseModel": body.get("model"),
                    "licenseRevision": target["licenseRevision"],
                    "targetFingerprint": hashed_target(target),
                }


    async def recognize(self, who, target_id, raw, *, request_id=None):
        from psycopg.types.json import Jsonb
        from .notification_security import principal
        from .portfolio_records import PortfolioRecords
        from .fx_reference import external_delivery_blocked
        from .record_snapshot_parser import parse_snapshot, raw_text
        from .local_record_vision import recognize as local_recognize
        target = self.target(who, target_id)
        mime = image_mime(raw)
        if request_id is None:raise HTTPException(400, "识别必须关联原UUID")
        parent = UUID(str(request_id));attempts=[];bindings={}
        primary_fingerprint=hashed_target(target)
        for index in range(2):
            identifier=uuid5(parent, "ocr-attempt:"+str(index))
            fingerprint=hashed_target(target)
            async with self.db.connection() as conn, conn.transaction():
                await PortfolioRecords(self.db).read_lock(conn,who.id,who)
                if await external_delivery_blocked(conn):raise HTTPException(503,"恢复副本禁止识别")
                if (hashed_target(self.target(who,target["id"]))!=fingerprint
                        or hashed_target(self.target(who,target_id))!=primary_fingerprint):raise HTTPException(403,"识别来源已变化")
                prior=await(await conn.execute("SELECT id FROM record_import_sources WHERE owner_id=%s AND request_id=%s",(who.id,identifier))).fetchone()
                if prior:return {"state":"unknown","rows":[],"childRequestIds":[str(identifier)],"willRetryAutomatically":False}
                await conn.execute("INSERT INTO record_import_sources(owner_id,id,request_id,fingerprint,format,filename,raw,sha256,principal,origin_instance,target_id) VALUES(%s,%s,%s,%s,'image',%s,%s,%s,%s,%s,%s)",
                    (who.id,identifier,identifier,fingerprint,'OCR attempt '+str(parent),raw,hashlib.sha256(raw).hexdigest(),principal(who),self.db.settings.instance_id,target['id']))
            original=None
            try:
                if target['provider']=='apple-vision':
                    original=await local_recognize(raw,mime)
                    lines=json.loads(original,object_pairs_hook=unique)
                    candidates=parse_snapshot(lines)
                    result={'state':'recognized','provider':'apple-vision','rows':[{k:str(v) if isinstance(v,(int,float)) else v for k,v in row.items()} for row in candidates],
                        'text':raw_text(lines),'requestedModel':'apple-vision-v1','targetFingerprint':fingerprint,'licenseRevision':target['licenseRevision'],
                        'recognitionAuthority':'heuristic_geometry_unconfirmed'}
                else:
                    result=await self.recognize_cloud(who,target['id'],raw)
                    original=result.pop('raw',None)
            except HTTPException as error:
                result={'state':'unavailable','rows':[],'reason':str(error.detail)}
            except Exception:
                result={'state':'unknown','rows':[],'reason':'识别结果未知，请只查询原UUID'}
            if original is not None:
                result['providerRawSha256']=hashlib.sha256(original).hexdigest()
            async with self.db.connection() as conn, conn.transaction():
                admission=await(await conn.execute('SELECT * FROM record_import_sources WHERE owner_id=%s AND request_id=%s',(who.id,identifier))).fetchone()
                instance=await(await conn.execute('SELECT instance_id FROM alcor_instance WHERE singleton')).fetchone()
                if (not admission or admission['fingerprint']!=fingerprint or admission['principal']!=principal(who)
                    or str(admission['origin_instance'])!=str(self.db.settings.instance_id) or not instance or str(instance['instance_id'])!=str(admission['origin_instance'])):
                    raise HTTPException(409,'识别原件与实例无法核对')
                await conn.execute('INSERT INTO record_import_source_results(owner_id,source_id,request_id,result,provider_raw) VALUES(%s,%s,%s,%s,%s)',(who.id,identifier,identifier,Jsonb(result),original))
            attempts.append(str(identifier))
            bindings[target['id']]=fingerprint
            result.update(raw=original,childRequestIds=attempts,attemptTargets=dict(bindings))
            # Only a known completed but empty cloud recognition permits the explicitly
            # installed local fallback. Unknown/timeout never issues another request.
            known_empty=result['state']=='recognized' and not result.get('rows')
            known_rejected=result['state']=='rejected' and result.get('complete') is True and 400<=result.get('status',0)<500
            if target['provider']!='deepseek' or not (known_empty or known_rejected) or not target.get('fallbackTargetId'):
                return result
            target=self.target(who,target['fallbackTargetId'])
            if target['provider']!='apple-vision':raise HTTPException(503,'识别备用来源必须是明确安装的Apple Vision')
        return result
