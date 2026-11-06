import io

from fontTools.fontBuilder import FontBuilder
from fontTools.pens.t2CharStringPen import T2CharStringPen
from fontTools.pens.ttGlyphPen import TTGlyphPen
from fontTools.ttLib import TTFont
from fontTools.ttLib.tables.DefaultTable import DefaultTable


def font_bytes(ext="ttf", seed=0, size=None):
    builder = FontBuilder(1000, isTTF=ext != "otf")
    builder.setupGlyphOrder([".notdef", "A"])
    builder.setupCharacterMap({65: "A"})
    if ext == "otf":
        glyphs = {}
        for name in [".notdef", "A"]:
            pen = T2CharStringPen(600, None)
            if name == "A":
                pen.moveTo((50, 0))
                pen.lineTo((300, 700))
                pen.lineTo((550, 0))
                pen.closePath()
            glyphs[name] = pen.getCharString()
        builder.setupCFF(
            "Fixture" + str(seed),
            {"FullName": "Synthetic Fixture", "FamilyName": "Synthetic Fixture", "Weight": "Regular"},
            glyphs,
            {},
        )
    else:
        glyphs = {}
        for name in [".notdef", "A"]:
            pen = TTGlyphPen(None)
            if name == "A":
                pen.moveTo((50, 0))
                pen.lineTo((300, 700))
                pen.lineTo((550, 0))
                pen.closePath()
            glyphs[name] = pen.glyph()
        builder.setupGlyf(glyphs)
    builder.setupHorizontalMetrics({".notdef": (600, 0), "A": (600 + seed, 0)})
    builder.setupHorizontalHeader(ascent=800, descent=-200)
    builder.setupNameTable(
        {
            "familyName": "Synthetic Fixture",
            "styleName": "Regular",
            "uniqueFontIdentifier": "Synthetic" + str(seed),
            "fullName": "Synthetic Fixture " + str(seed),
            "psName": "SyntheticFixture" + str(seed),
        }
    )
    builder.setupOS2(sTypoAscender=800, sTypoDescender=-200, usWinAscent=800, usWinDescent=200)
    builder.setupPost()
    builder.setupMaxp()
    builder.font["head"].created = 3786912000
    builder.font["head"].modified = 3786912000
    builder.font.recalcTimestamp = False
    output = io.BytesIO()
    builder.save(output)
    if ext in ("woff", "woff2"):
        font = TTFont(io.BytesIO(output.getvalue()), recalcTimestamp=False)
        font.flavor = ext
        output = io.BytesIO()
        font.save(output)
        font.close()
    if size is not None:
        assert ext == "ttf" and size % 4 == 0
        font = TTFont(io.BytesIO(output.getvalue()), recalcTimestamp=False)
        table = DefaultTable("PADD")
        table.data = b""
        font["PADD"] = table
        output = io.BytesIO()
        font.save(output)
        table.data = b"x" * (size - len(output.getvalue()))
        output = io.BytesIO()
        font.save(output)
        font.close()
        assert len(output.getvalue()) == size
    return output.getvalue()
