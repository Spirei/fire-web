"""Owner feed profile images retain their original animation and bytes."""
import io
from pathlib import PurePath
from PIL import Image
from fastapi import HTTPException


def avatar_mime(raw,filename=None):
    if not isinstance(raw,bytes)or not 0<len(raw)<=2*1024*1024:raise HTTPException(413,'动态形象最大2MB')
    try:
        with Image.open(io.BytesIO(raw))as image:
            fmt=image.format
            if fmt not in {'PNG','JPEG','GIF','WEBP'}:raise ValueError()
            actual={'PNG':'png','JPEG':'jpg','GIF':'gif','WEBP':'webp'}[fmt]
            if filename is not None:
                ext=PurePath(filename).suffix.lower().removeprefix('.')
                if ext=='jpeg':ext='jpg'
                if ext!=actual:raise ValueError()
            count=getattr(image,'n_frames',1)
            if count>500 or image.width*image.height*count>100_000_000:raise ValueError()
            for index in range(count):image.seek(index);image.load()
        return {'PNG':'image/png','JPEG':'image/jpeg','GIF':'image/gif','WEBP':'image/webp'}[fmt]
    except Exception:raise HTTPException(400,'请选择内容与扩展名相符且在解码预算内的PNG/JPG/GIF/WEBP形象')from None
