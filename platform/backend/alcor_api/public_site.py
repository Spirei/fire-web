"""Public brand artwork and explicitly redistributable stored ticker observations."""

import asyncio
import hashlib
import io
from decimal import Decimal
from functools import lru_cache
from importlib.resources import files
from urllib.parse import parse_qs, urlsplit
from uuid import UUID

from fastapi import HTTPException

from .identity_mail import IdentityMail
from .public_market_authority import PublicAuthority
from .public_market_quotes import PublicQuotes
from .site_settings import SiteSettings
from .system_assets import SystemAssets


def bundled(name):return files('alcor_api').joinpath('data',name).read_bytes()


@lru_cache(maxsize=16)
def png(raw,size,*,background=None,enlarge=True):
    from PIL import Image, ImageOps
    if b'<svg' in raw[:1024]:
        from cairosvg.surface import PNGSurface

        from .system_asset_codec import image_bytes
        safe,_=image_bytes(raw,'svg')
        def deny(*_args,**_kwargs):raise ValueError('artwork_external_reference_forbidden')
        raw=PNGSurface.convert(bytestring=safe,output_width=512,output_height=512,unsafe=False,url_fetcher=deny)
    with Image.open(io.BytesIO(raw)) as source:
        if source.width*source.height>24000000:raise ValueError('artwork_pixel_budget')
        image=ImageOps.exif_transpose(source).convert('RGBA')
        if enlarge:image=ImageOps.contain(image,(size,size),Image.Resampling.LANCZOS)
        else:image.thumbnail((size,size),Image.Resampling.LANCZOS)
        canvas=Image.new('RGBA',(size,size),background or (0,0,0,0));canvas.alpha_composite(image,((size-image.width)//2,(size-image.height)//2))
        output=io.BytesIO();canvas.save(output,format='PNG');return output.getvalue()


@lru_cache(maxsize=8)
def banner(raw,label):
    from PIL import Image, ImageDraw, ImageFont
    logo=Image.open(io.BytesIO(png(raw,148))).convert('RGBA')
    image=Image.new('RGBA',(1080,280),'#f5f5f5');draw=ImageDraw.Draw(image)
    image.alpha_composite(logo,(64,66))
    font=ImageFont.load_default(size=48)
    draw.text((252,100),label[:32],fill='#171717',font=font)
    output=io.BytesIO();image.save(output,format='PNG');return output.getvalue()


def sample_points(points,target=56):
    if len(points)<=target:return points
    buckets=max(1,(target-2)//2);middle=len(points)-2;result=[points[0]]
    for bucket in range(buckets):
        start=1+bucket*middle//buckets;end=1+(bucket+1)*middle//buckets
        indices=list(range(start,end))
        low=min(indices,key=lambda index:Decimal(points[index]));high=max(indices,key=lambda index:Decimal(points[index]))
        result.extend(points[index] for index in sorted({low,high}))
    return result+[points[-1]]


class PublicSite:
    def __init__(self,db):
        self.db=db;self.settings=SiteSettings(db,IdentityMail(db.settings,db,dynamic=True))
        self.public_authority=PublicAuthority(db,policy_provider=lambda:db.settings.public_market_data_policies)
        self.public_quotes=PublicQuotes(self.public_authority)

    async def artwork(self,source):
        if not source:return bundled('public_site_default.svg')
        parsed=urlsplit(source);sha=parse_qs(parsed.query).get('sha256',[None])
        if parsed.scheme or parsed.netloc or len(sha)!=1 or not sha[0]:raise HTTPException(503,'公开品牌素材版本不可用')
        row,stream=await SystemAssets(self.db).public(parsed.path,sha[0])
        try:
            if row['served_size']>10*1024*1024:raise HTTPException(503,'品牌素材超过转换预算')
            raw=stream.read(10*1024*1024+1)
            if len(raw)!=row['served_size']:raise HTTPException(503,'品牌素材原件不完整')
            return raw
        finally:stream.close()

    async def icon(self,size=192,version=None,*,favicon=False):
        public=await self.settings.public();source=public['ico']
        if not favicon:
            from .site_registration import installed
            async with self.db.connection() as conn:
                ready=await installed(conn)
                choice=await(await conn.execute("SELECT settings->>'pwaIcon' AS icon FROM site_settings WHERE singleton")).fetchone() if ready else None
                if choice and choice['icon']:
                    try:identifier=UUID(choice['icon'])
                    except (ValueError,TypeError):raise HTTPException(503,'桌面图标登记版本无效') from None
                    row=await(await conn.execute("SELECT public_path,served_sha256 FROM system_asset_versions WHERE id=%s AND kind='ico'",(identifier,))).fetchone()
                    if not row:raise HTTPException(503,'桌面图标登记原件不可用')
                    source=row['public_path']+'?sha256='+row['served_sha256']
        if favicon and not source:raise HTTPException(404,'尚未登记站点图标')
        raw=await self.artwork(source)
        try:
            artwork=await asyncio.to_thread(png,raw,512,background='#0a0e19')
            actual=hashlib.sha256(artwork).hexdigest()[:24]
            if version is not None and version!=actual:raise HTTPException(404,'PWA图标版本已变化')
            result=await asyncio.to_thread(png,raw,64,enlarge=False) if favicon else artwork if size==512 else await asyncio.to_thread(png,artwork,size)
            return result,actual
        except HTTPException:raise
        except Exception:raise HTTPException(503,'品牌图片尚不能可靠转换为PNG')  # noqa: BLE001 -- sanitize bounded image codec failures from None

    async def mail_banner(self):
        public=await self.settings.public();raw=await self.artwork(public['siteLogo'])
        try:return await asyncio.to_thread(banner,raw,public['logoText'])
        except Exception:raise HTTPException(503,'邮件品牌图片暂不可用')  # noqa: BLE001 -- sanitize bounded image codec failures from None

    async def manifest(self):
        public=await self.settings.public();_,version=await self.icon(512)
        return {'name':public['title'],'short_name':public['logoText'][:12],'start_url':'/','id':'/','scope':'/','display':'standalone','orientation':'portrait',
                'background_color':'#0a0e19','theme_color':'#0a0e19','lang':'zh-CN',
                'icons':[{'src':'/api/pwa-icon?v='+version+'&size='+str(size),'sizes':str(size)+'x'+str(size),'type':'image/png'} for size in (192,512)]}

    async def ticker(self):
        from .public_site_ticker import read_ticker
        return await read_ticker(self.db,self.public_authority,self.public_quotes)
