"""Safe presentation of legacy SVG raster embeds; original files are never changed."""

import base64
import io
import re
import xml.etree.ElementTree as ET

from fastapi import HTTPException
from PIL import Image

from .system_asset_codec import SVG_NS, image_bytes, safe_svg, strip_doctype


def display_bytes(raw, extension):
    try:
        return image_bytes(raw, extension)
    except HTTPException:
        if extension.lower() in {"png", "jpg", "jpeg", "gif", "webp"}:
            # Historical manifests sometimes named a JPEG .png. Validate its
            # actual raster format and serve that MIME without changing bytes,
            # filenames, original hashes or the strict new-upload contract.
            try:
                with Image.open(io.BytesIO(raw), formats=["PNG", "JPEG", "GIF", "WEBP"]) as raster:
                    actual = {"PNG": "png", "JPEG": "jpg", "GIF": "gif", "WEBP": "webp"}[raster.format]
                    if not 0 < raster.width * raster.height <= 16777216:
                        raise ValueError()
                    raster.verify()
                with Image.open(io.BytesIO(raw), formats=["PNG", "JPEG", "GIF", "WEBP"]) as raster:
                    raster.load()
                return image_bytes(raw, actual)
            except (ValueError, KeyError, OSError, Image.DecompressionBombError):
                raise HTTPException(400, "历史图片内容无法安全读取") from None
        if extension.lower() != "svg":
            raise
    try:
        # ElementTree does not fetch remote entities. The served serialization omits the DTD.
        if len(raw) > 20 * 1024 * 1024:
            raise ValueError()
        root = ET.fromstring(strip_doctype(raw.decode("utf-8")))
        if root.tag != "{" + SVG_NS + "}svg":
            raise ValueError()
        # Inkscape/RDF metadata is non-rendering and failed the strict SVG
        # element allowlist. Remove only those editor annotations from the
        # presentation; the original file and its checksum remain untouched.
        editor_namespaces = {"http://www.inkscape.org/namespaces/inkscape", "http://sodipodi.sourceforge.net/DTD/sodipodi-0.dtd"}
        for parent in root.iter():
            for child in list(parent):
                namespace = child.tag[1:].split('}', 1)[0] if child.tag.startswith('{') else ''
                if child.tag == '{' + SVG_NS + '}metadata' or namespace in editor_namespaces:
                    parent.remove(child)
            for key in list(parent.attrib):
                if key.startswith('{') and key[1:].split('}', 1)[0] in editor_namespaces:
                    del parent.attrib[key]
        checked = ET.fromstring(ET.tostring(root))
        total_pixels = 0
        for index, node in enumerate(checked.iter()):
            if index > 10000:
                raise ValueError()
            if node.tag != "{" + SVG_NS + "}image":
                continue
            hrefs = [key for key in node.attrib if key.rsplit("}", 1)[-1] == "href"]
            if len(hrefs) != 1:
                raise ValueError()
            matched = re.fullmatch(
                r"data:image/(png|jpeg|webp);base64,([A-Za-z0-9+/=\s]+)", node.attrib[hrefs[0]]
            )
            if not matched:
                raise ValueError()
            image = base64.b64decode(re.sub(r"\s+", "", matched[2]), validate=True)
            if len(image) > 12 * 1024 * 1024:
                raise ValueError()
            with Image.open(
                io.BytesIO(image), formats=[{"png": "PNG", "jpeg": "JPEG", "webp": "WEBP"}[matched[1]]]
            ) as raster:
                pixels = raster.width * raster.height
                total_pixels += pixels
                if not 0 < pixels <= 33554432 or total_pixels > 67108864:
                    raise ValueError()
                raster.verify()
            # Validate every other SVG element and attribute through the shared strict checker.
            node.tag = "{" + SVG_NS + "}rect"
            node.attrib[hrefs[0]] = "#validated-embedded-raster"
        if not safe_svg(ET.tostring(checked, encoding="unicode")):
            raise ValueError()
        return ET.tostring(root, encoding="utf-8"), "image/svg+xml"
    except (ValueError, OSError, ET.ParseError, Image.DecompressionBombError):
        raise HTTPException(400, "SVG 内嵌图片无法安全读取") from None
