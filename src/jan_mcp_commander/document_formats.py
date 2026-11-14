"""Bounded, non-executing document transformations used by the isolated worker."""
import base64
import csv
import hashlib
import io
import re
from xml.dom import minidom
from zipfile import ZipFile, ZIP_DEFLATED

from .office_documents import package, W
from .privacy import assert_public_text

WORD = W[1:-1]
MAX_TEXT = 64000


def word_nodes(node, name):
    return list(node.getElementsByTagNameNS(WORD, name))


def word_text(node):
    return ''.join(child.data for t in word_nodes(node,'t') for child in t.childNodes
                   if child.nodeType in {child.TEXT_NODE,child.CDATA_SECTION_NODE})


def load_docx(data):
    files = package(data)
    if 'word/document.xml' not in files or 'xl/workbook.xml' in files:
        raise ValueError('DOCX document part required')
    if any(name.startswith('_xmlsignatures/') for name in files):
        raise ValueError('Signed Word documents are read-only')
    if '[Content_Types].xml' in files and b'wordprocessingml.document.main+xml' not in files['[Content_Types].xml']:
        raise ValueError('DOCX content type required')
    dom = minidom.parseString(files['word/document.xml'])
    if dom.documentElement.namespaceURI != WORD or dom.documentElement.localName != 'document':
        raise ValueError('Invalid Word root element')
    paragraphs = word_nodes(dom, 'p')
    if any(child.nodeType==child.ELEMENT_NODE for t in word_nodes(dom,'t') for child in t.childNodes):
        raise ValueError('Malformed nested element in Word text')
    if len(paragraphs) > 2000:
        raise ValueError('Word paragraph limit is 2000')
    total = '\n'.join(word_text(p) for p in paragraphs)
    if len(total) > MAX_TEXT:
        raise ValueError('Word text exceeds 64000 characters')
    assert_public_text(total)
    return files, dom, paragraphs


def docx_model(data):
    _, dom, paragraphs = load_docx(data)
    locations = []
    for index, paragraph in enumerate(paragraphs, 1):
        style = word_nodes(paragraph, 'pStyle')
        locations.append({'location': f'p{index:05d}', 'text': word_text(paragraph),
            'style': style[0].getAttributeNS(WORD, 'val') if style else '',
            'editable': not any(word_nodes(paragraph, name) for name in
                ('instrText', 'fldChar', 'drawing', 'object', 'del', 'ins', 'tab', 'br', 'txbxContent'))})
    tables = []
    for index, table in enumerate(word_nodes(dom, 'tbl'), 1):
        rows = []
        for row in [n for n in table.childNodes if n.nodeType == n.ELEMENT_NODE and n.localName == 'tr']:
            cells = [word_text(n) for n in row.childNodes if n.nodeType == n.ELEMENT_NODE and n.localName == 'tc']
            if len(cells) > 20:
                raise ValueError('Word table column limit is 20')
            rows.append(cells)
        if len(rows) > 100 or len(tables) >= 20:
            raise ValueError('Word table limits exceeded')
        record={'location': f't{index:05d}', 'rows': rows}
        if word_nodes(table,'tbl') or word_nodes(table,'gridSpan') or word_nodes(table,'vMerge'):
            record.update(supported=False,needs_review=True,limitation='Nested or merged Word tables require native Office inspection')
        tables.append(record)
    return {'locations': locations, 'tables': tables, 'paragraph_count': len(paragraphs)}


def edit_docx(data, edits=None, values=None):
    files, dom, paragraphs = load_docx(data)
    model = docx_model(data)
    if values is not None:
        if not isinstance(values, dict) or not 1 <= len(values) <= 30:
            raise ValueError('Template needs 1..30 approved values')
        import json
        assert_public_text(json.dumps(values))
        for key, value in values.items():
            if not re.fullmatch(r'[A-Za-z][A-Za-z0-9_]{0,47}', key) or not isinstance(value, str) or len(value) > 2048:
                raise ValueError('Use bounded template names and plain text values')
            assert_public_text(value)
            if re.search(r'\{\{[^{}]+\}\}', value):
                raise ValueError('Template values cannot contain placeholders')
        tokens = re.findall(r'\{\{([A-Za-z][A-Za-z0-9_]{0,47})\}\}', '\n'.join(p['text'] for p in model['locations']))
        if set(tokens) != set(values):
            raise ValueError('Template values must exactly cover all body placeholders; missing/unused values denied')
        edits = [{'location': p['location'], 'old': '{{'+key+'}}', 'new': value}
                 for p in model['locations'] for key, value in values.items() if '{{'+key+'}}' in p['text']]
    if not isinstance(edits, list) or not 1 <= len(edits) <= 50:
        raise ValueError('Choose 1..50 exact paragraph edits')
    changes, by_paragraph = [], {}
    for edit in edits:
        if not isinstance(edit, dict) or set(edit) != {'location', 'old', 'new'}:
            raise ValueError('Each edit needs location, old and new')
        location, old, new = edit['location'], edit['old'], edit['new']
        if not isinstance(location, str) or not re.fullmatch(r'p[0-9]{5}', location):
            raise ValueError('Use a paragraph location from inspection')
        index = int(location[1:])-1
        if not 0 <= index < len(paragraphs):
            raise ValueError('Paragraph location does not exist')
        if not isinstance(old, str) or not old or len(old) > 4096 or not isinstance(new, str) or len(new) > 4096:
            raise ValueError('Edit text must be bounded; old cannot be empty')
        if any(ord(c) < 32 for c in old+new):
            raise ValueError('Paragraph edits cannot introduce control characters')
        assert_public_text(old); assert_public_text(new)
        record = model['locations'][index]
        if not record['editable']:
            raise ValueError('Field, tracked-change, drawing or non-text paragraph needs manual editing')
        before = record['text']
        first=before.find(old)
        if first<0 or before.find(old,first+1)>=0:
            raise ValueError('Stale or ambiguous replacement; old text must occur exactly once at this location')
        start = before.index(old); end = start+len(old)
        ranges = by_paragraph.setdefault(index, [])
        if any(start < b and end > a for a,b,_ in ranges):
            raise ValueError('Overlapping or duplicate replacements denied')
        ranges.append((start, end, new))
        changes.append({'location': location, 'before': old, 'after': new})
    expected = {}
    for index, ranges in by_paragraph.items():
        paragraph = paragraphs[index]
        current = model['locations'][index]['text']
        for start, end, new in sorted(ranges, reverse=True):
            nodes = [child for t in word_nodes(paragraph,'t') for child in t.childNodes
                     if child.nodeType in {child.TEXT_NODE,child.CDATA_SECTION_NODE}]
            offsets, offset = [], 0
            for node in nodes:
                text = node.data
                offsets.append((offset, offset+len(text), node, text)); offset += len(text)
            touched = [(a,b,node,text) for a,b,node,text in offsets if a < end and b > start]
            if not touched:
                raise ValueError('Replacement did not address ordinary Word text')
            for n,(a,b,node,text) in enumerate(touched):
                replacement = (text[:max(0,start-a)] + new if n == 0 else '')
                if n == len(touched)-1:
                    replacement += text[end-a:]
                if node.nodeType==node.CDATA_SECTION_NODE and ']]>' in replacement:
                    replacement_node=dom.createTextNode(replacement)
                    node.parentNode.replaceChild(replacement_node,node);node=replacement_node
                else: node.data=replacement
                node.parentNode.setAttribute('xml:space', 'preserve')
            current = current[:start]+new+current[end:]
        expected[f'p{index+1:05d}'] = current
    files['word/document.xml'] = dom.toxml(encoding='utf-8')
    out = io.BytesIO()
    with ZipFile(io.BytesIO(data)) as original, ZipFile(out, 'w', ZIP_DEFLATED) as archive:
        for item in original.infolist():
            if not item.is_dir(): archive.writestr(item, files[item.filename])
    result = out.getvalue()
    reopened = docx_model(result)
    actual = {p['location']: p['text'] for p in reopened['locations']}
    if any(actual[location] != text for location,text in expected.items()):
        raise ValueError('Word reopen verification failed; no output saved')
    return result, {'changes': changes, 'verified': True, 'paragraphs_checked': list(expected)}


def docx_markdown(data):
    files, dom, _ = load_docx(data)
    if any(re.match(r'word/(header|footer|footnotes|endnotes)', name) for name in files) or any(
        word_nodes(dom, tag) for tag in ('drawing','object','altChunk','fldChar','instrText','txbxContent','ins','del','tab','br')):
        raise ValueError('PDF export supports body headings, paragraphs and tables only; complex Word layout needs native Office export')
    body = word_nodes(dom, 'body')[0]
    lines = []
    for child in body.childNodes:
        if child.nodeType != child.ELEMENT_NODE: continue
        if child.localName == 'p':
            styles = word_nodes(child, 'pStyle')
            style = styles[0].getAttributeNS(WORD, 'val') if styles else ''
            level = re.fullmatch(r'Heading([1-6])', style, re.I)
            text=word_text(child)
            if not level and text.startswith(('#','|','![')):text='\\'+text
            lines.append(('#'*int(level[1])+' ' if level else '')+text)
        elif child.localName == 'tbl':
            if word_nodes(child,'tbl') or word_nodes(child,'gridSpan') or word_nodes(child,'vMerge'):
                raise ValueError('Nested or merged Word tables require native Office export')
            rows = [[word_text(cell).replace('|', '\\|') for cell in row.childNodes if cell.nodeType == cell.ELEMENT_NODE and cell.localName == 'tc']
                    for row in child.childNodes if row.nodeType == row.ELEMENT_NODE and row.localName == 'tr']
            for index,row in enumerate(rows):
                lines.append('| '+' | '.join(row)+' |')
                if index == 0: lines.append('| '+' | '.join('---' for _ in row)+' |')
        elif child.localName != 'sectPr':
            raise ValueError('Unsupported body element in Word PDF export')
        lines.append('')
    return '\n'.join(lines)


def table_csv(tables):
    if not tables:
        raise ValueError('No supported tables found; no empty extraction is claimed')
    if any(table.get('supported') is False for table in tables):
        raise ValueError('Nested or merged Word table extraction is unsupported; inspect it in Office')
    out = io.StringIO(newline=''); writer = csv.writer(out); escaped = 0
    for index, table in enumerate(tables):
        if index: writer.writerow([])
        for row in table['rows']:
            clean = []
            for value in row:
                assert_public_text(value)
                if value.lstrip().startswith(('=', '+', '-', '@', '\t', '\r')):
                    value = "'"+value; escaped += 1
                clean.append(value)
            writer.writerow(clean)
    encoded = out.getvalue().encode('utf-8-sig')
    if len(encoded) > 128000: raise ValueError('CSV extraction exceeds 128000 bytes')
    return encoded, {'tables': tables, 'formula_cells_escaped': escaped, 'encoding': 'UTF-8 BOM', 'verified': True}
