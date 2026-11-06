"""Bounded OOXML order-sheet transport; no workbook code or formulas execute."""

import io
import posixpath
import re
import zipfile
from decimal import Decimal
from xml.etree import ElementTree as ET
from xml.sax.saxutils import escape

from fastapi import HTTPException

MAX_BYTES = 16 * 1024 * 1024
NS = "{http://schemas.openxmlformats.org/spreadsheetml/2006/main}"
REL = "{http://schemas.openxmlformats.org/officeDocument/2006/relationships}id"
HEADERS = [
    "订单状态",
    "市场",
    "股票代码",
    "股票名称",
    "方向",
    "委托类型",
    "委托数量",
    "委托价格",
    "触发价格",
    "币种",
    "委托时间",
    "成交均价",
    "成交数量",
    "成交金额",
    "剩余挂单数量",
    "撤/废单数量",
    "有效期",
    "时段",
    "触发状态",
    "订单号",
    "驳回原因",
    "账户归属",
    "结算币种",
    "实际结算净额",
]
DETAIL = [
    "订单号",
    "订单状态",
    "市场",
    "股票代码",
    "股票名称",
    "方向",
    "委托类型",
    "委托数量",
    "委托价格",
    "币种",
    "委托时间",
    "成交均价",
    "成交数量",
    "成交金额",
    "费用",
    "已实现盈亏",
    "成交后持仓数量",
    "成交后持仓成本",
    "有效期",
    "时段",
    "触发状态",
    "驳回原因",
    "备注",
    "账户归属",
    "结算币种",
    "实际结算净额",
]


def xml(raw):
    if b"\x00" in raw:
        raise ValueError("订单XML须为UTF-8")
    if b"<!DOCTYPE" in raw.upper() or b"<!ENTITY" in raw.upper():
        raise ValueError("不支持XML实体")
    return ET.fromstring(raw)


def read_sheet(raw):
    try:
        if not 0 < len(raw) <= MAX_BYTES:
            raise ValueError("文件过大，最大16MB")
        with zipfile.ZipFile(io.BytesIO(raw)) as archive:
            entries = archive.infolist()
            if not 1 <= len(entries) <= 2000 or len({i.filename for i in entries}) != len(entries):
                raise ValueError("xlsx条目无效")
            total = 0
            blobs = {}
            for info in entries:
                if (
                    info.flag_bits & 1
                    or info.compress_type not in (0, 8)
                    or info.file_size > 20 * 1024 * 1024
                    or info.file_size > max(1, info.compress_size) * 200
                ):
                    raise ValueError("xlsx条目过大或加密")
                total += info.file_size
                if total > 50 * 1024 * 1024:
                    raise ValueError("xlsx解压后过大")
                with archive.open(info) as stream:
                    content = stream.read(min(info.file_size, 20 * 1024 * 1024) + 1)
                    if len(content) != info.file_size:
                        raise ValueError("xlsx长度不符")
                    blobs[info.filename] = content
            names = []
            if "xl/workbook.xml" in blobs and "xl/_rels/workbook.xml.rels" in blobs:
                targets = {
                    node.attrib.get("Id"): node.attrib.get("Target", "")
                    for node in xml(blobs["xl/_rels/workbook.xml.rels"])
                    if node.attrib.get("TargetMode") != "External"
                }
                for node in xml(blobs["xl/workbook.xml"]).iter(NS + "sheet"):
                    target = targets.get(node.attrib.get(REL), "")
                    name = (
                        posixpath.normpath(posixpath.join("xl", target))
                        if not target.startswith("/")
                        else target.lstrip("/")
                    )
                    if name.startswith("xl/worksheets/") and name in blobs:
                        names.append(name)
            if not names:
                names = sorted(k for k in blobs if re.fullmatch(r"xl/worksheets/sheet\d+\.xml", k))
            for name in names:
                rows = []
                for row in xml(blobs[name]).iter(NS + "row"):
                    if len(rows) >= 20001:
                        raise ValueError("单次最多导入20000条订单，请拆分文件")
                    cells = {}
                    nodes = list(row)
                    if len(nodes) > 128:
                        raise ValueError("订单列数超过128")
                    for cell in nodes:
                        ref = cell.attrib.get("r", "")
                        match = re.fullmatch(r"([A-Z]{1,3})\d+", ref)
                        if not match:
                            continue
                        if cell.attrib.get("t") == "inlineStr":
                            value = "".join(n.text or "" for n in cell.iter(NS + "t"))
                        elif cell.attrib.get("t") == "s":
                            raise ValueError("订单导入只接受原协议inlineStr或数值单元格")
                        else:
                            value = cell.findtext(NS + "v", "")
                        if len(value) > 8192:
                            raise ValueError("订单单元格过长")
                        cells[match[1]] = value
                    rows.append(cells)
                if not rows:
                    continue
                header = next((index for index, row in enumerate(rows) if row.get("A") == "订单状态"), None)
                if header is None:
                    continue
                mapping = rows[header]
                return [
                    {**row, **{label: row.get(column, "") for column, label in mapping.items() if label}}
                    for row in rows[header + 1 :]
                    if any(row.values())
                ]
            raise ValueError("未找到订单状态表头")
    except (
        ValueError,
        KeyError,
        ET.ParseError,
        zipfile.BadZipFile,
        RuntimeError,
        OSError,
        NotImplementedError,
    ) as exc:
        raise HTTPException(422, "无法解析订单xlsx：" + str(exc)[:160]) from None


def col(index):
    result = ""
    while index:
        index, part = divmod(index - 1, 26)
        result = chr(65 + part) + result
    return result


def build_xlsx(sheets):
    output = io.BytesIO()
    with zipfile.ZipFile(output, "w", zipfile.ZIP_DEFLATED) as archive:
        archive.writestr(
            "[Content_Types].xml",
            '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>'
            + "".join(
                f'<Override PartName="/xl/worksheets/sheet{i}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>'
                for i in range(1, len(sheets) + 1)
            )
            + "</Types>",
        )
        archive.writestr(
            "_rels/.rels",
            '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>',
        )
        archive.writestr(
            "xl/workbook.xml",
            '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>'
            + "".join(
                f'<sheet name="{escape(name)}" sheetId="{i}" r:id="rId{i}"/>'
                for i, (name, _) in enumerate(sheets, 1)
            )
            + "</sheets></workbook>",
        )
        archive.writestr(
            "xl/_rels/workbook.xml.rels",
            '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
            + "".join(
                f'<Relationship Id="rId{i}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet{i}.xml"/>'
                for i in range(1, len(sheets) + 1)
            )
            + "</Relationships>",
        )
        for index, (_, rows) in enumerate(sheets, 1):
            data = [
                '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>'
            ]
            for number, row in enumerate(rows, 1):
                cells = []
                for column, value in enumerate(row, 1):
                    ref = col(column) + str(number)
                    if isinstance(value, (int, float, Decimal)) and not isinstance(value, bool):
                        cells.append(f'<c r="{ref}"><v>{value}</v></c>')
                    else:
                        text = "—" if value is None else str(value)
                        text = "".join(c for c in text if c in "\n\r\t" or ord(c) >= 32)
                        cells.append(
                            f'<c r="{ref}" t="inlineStr"><is><t xml:space="preserve">{escape(text)}</t></is></c>'
                        )
                data.append(f'<row r="{number}">' + "".join(cells) + "</row>")
            data.append("</sheetData></worksheet>")
            archive.writestr(f"xl/worksheets/sheet{index}.xml", "".join(data))
    return output.getvalue()
