"""Bounded record-only XLSX normalization; never changes the order workbook protocol."""
import io
import re
from zipfile import ZipFile
from xml.etree import ElementTree as ET

from .legacy_order_workbooks import NS, read_sheet, xml


def record_sheet(raw):
    if not 0 < len(raw) <= 16 * 1024 * 1024:
        raise ValueError('record_xlsx_budget')
    with ZipFile(io.BytesIO(raw)) as archive:
        entries = archive.infolist()
        if (not 1 <= len(entries) <= 2000 or len({i.filename for i in entries}) != len(entries)
                or sum(i.file_size for i in entries) > 50 * 1024 * 1024):
            raise ValueError('record_xlsx_entries')
        blobs = {}
        for item in entries:
            if (item.flag_bits & 1 or item.compress_type not in (0, 8) or item.file_size > 20 * 1024 * 1024
                    or item.file_size > max(1, item.compress_size) * 200
                    or item.filename.lower().endswith('.bin')):
                raise ValueError('record_xlsx_entry_budget_or_macro')
            with archive.open(item) as stream:
                content = stream.read(item.file_size + 1)
            if len(content) != item.file_size:
                raise ValueError('record_xlsx_entry_length')
            blobs[item.filename] = content
        strings = []
        if 'xl/sharedStrings.xml' in blobs:
            for node in xml(blobs['xl/sharedStrings.xml']).findall(NS + 'si'):
                value = ''.join(n.text or '' for n in node.iter(NS + 't'))
                if len(value) > 8192 or len(strings) >= 100000:
                    raise ValueError('record_xlsx_string_budget')
                strings.append(value)
        for name, content in list(blobs.items()):
            if name.endswith('.rels'):
                if any(n.attrib.get('TargetMode') == 'External' for n in xml(content)):
                    raise ValueError('record_xlsx_external_relation')
            if not re.fullmatch(r'xl/worksheets/sheet\d+\.xml', name):
                continue
            root = xml(content)
            if any(True for _ in root.iter(NS + 'f')):
                raise ValueError('record_xlsx_formula_requires_values')
            for cell in root.iter(NS + 'c'):
                if cell.attrib.get('t') == 's':
                    index = cell.findtext(NS + 'v', '')
                    if not re.fullmatch(r'[0-9]{1,6}', index) or int(index) >= len(strings):
                        raise ValueError('record_xlsx_shared_string_index')
                    for child in list(cell):
                        cell.remove(child)
                    cell.set('t', 'inlineStr')
                    ET.SubElement(ET.SubElement(cell, NS + 'is'), NS + 't').text = strings[int(index)]
            # The existing bounded reader expects its anchor in column A.
            # This record-only in-memory alias never changes the archived workbook.
            for row in root.iter(NS + 'row'):
                first = next((c for c in row if re.fullmatch(r'A\d+', c.attrib.get('r', ''))), None)
                if first is not None:
                    texts = list(first.iter(NS + 't'))
                    if ''.join(n.text or '' for n in texts) in {'名称', 'name', '股票名称'}:
                        for n in texts:
                            n.text = ''
                        texts[0].text = '订单状态'
                        break
            blobs[name] = ET.tostring(root)
        output = io.BytesIO()
        with ZipFile(output, 'w') as target:
            for name, content in blobs.items():
                target.writestr(name, content)
    return read_sheet(output.getvalue())
