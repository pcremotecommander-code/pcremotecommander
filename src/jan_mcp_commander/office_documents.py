"""Bounded OOXML inspection and exact-cell editing. No Office code or formulas execute."""
import base64
import hashlib
import io
import json
import math
import os
from pathlib import Path, PurePosixPath
import re
import stat
import subprocess
import sys
import xml.etree.ElementTree as ET
from zipfile import ZipFile, ZIP_DEFLATED

MAX_FILE = 8 * 1024 * 1024
XML_LIMIT = 2 * 1024 * 1024
S = '{http://schemas.openxmlformats.org/spreadsheetml/2006/main}'
R = '{http://schemas.openxmlformats.org/officeDocument/2006/relationships}'
P = '{http://schemas.openxmlformats.org/package/2006/relationships}'
W = '{http://schemas.openxmlformats.org/wordprocessingml/2006/main}'


def xml(data):
    if len(data) > XML_LIMIT:
        raise ValueError('Office XML declarations or size denied')
    text=data.decode('utf-8-sig')
    if '\x00' in text or re.search(r'<!\s*(DOCTYPE|ENTITY)',text,re.I):
        raise ValueError('Office XML declarations or encoding denied')
    return ET.fromstring(text)


def package(data):
    from jan_mcp_commander.privacy import assert_public_text
    if not data.startswith(b'PK') or len(data) > MAX_FILE:
        raise ValueError('Use a bounded unencrypted DOCX or XLSX file')
    files = {}
    with ZipFile(io.BytesIO(data)) as archive:
        entries = archive.infolist()
        if len(entries) > 256 or sum(item.file_size for item in entries) > 16 * 1024 * 1024:
            raise ValueError('Office package extraction limit exceeded')
        seen = set()
        for item in entries:
            path = PurePosixPath(item.filename)
            key = item.filename.casefold()
            if (path.is_absolute() or '..' in path.parts or path.as_posix()!=item.filename.rstrip('/') or '\\' in item.filename or ':' in item.filename
                    or key in seen or stat.S_ISLNK(item.external_attr >> 16) or item.flag_bits & 1
                    or item.file_size > 4 * 1024 * 1024
                    or item.file_size > max(1, item.compress_size) * 200):
                raise ValueError('Unsafe or oversized Office package entry')
            seen.add(key)
            if any(word in key for word in ('vbaproject', 'externallinks/', 'embeddings/', 'customui/', 'activex/')):
                raise ValueError('Macros, embedded objects and external links are unsupported')
            if item.is_dir():
                continue
            files[item.filename] = archive.read(item)
            if key.endswith(('.xml', '.rels')):
                tree = xml(files[item.filename])
                assert_public_text('\n'.join(tree.itertext()))
                if key.endswith('.rels') and any(node.get('TargetMode', '').casefold() == 'external' or '://' in node.get('Target','') or node.get('Target','').startswith('\\\\') for node in tree):
                    raise ValueError('External Office relationships are unsupported')
                if key == '[content_types].xml' and any('macroenabled' in node.get('ContentType', '').casefold() for node in tree):
                    raise ValueError('Macro-enabled Office files are unsupported')
    shared=[''.join(node.itertext()) for node in xml(files['xl/sharedStrings.xml'])] if 'xl/sharedStrings.xml' in files else []
    for name,content in files.items():
        if name.startswith('xl/worksheets/') and name.endswith('.xml'):
            nodes=list(xml(content).iter(S+'c'))
            cells={cell.get('r',''):cell for cell in nodes}
            if len(nodes)!=len(cells):raise ValueError('Duplicate worksheet cells are unsupported')
            protect_cells(cells,shared)
        elif name=='word/document.xml':
            for row in xml(content).iter(W+'tr'):
                values=[''.join(cell.itertext()) for cell in row.findall(W+'tc')]
                for left,right in zip(values,values[1:]):assert_public_text(left+'='+right)
    return files


def address(value):
    match = re.fullmatch(r'([A-Z]{1,3})([1-9][0-9]{0,6})', value if isinstance(value, str) else '')
    if not match:
        raise ValueError('Use an A1-style cell address')
    column = 0
    for char in match[1]:
        column = column * 26 + ord(char) - 64
    if column > 16384 or int(match[2]) > 1048576:
        raise ValueError('Cell exceeds XLSX bounds')
    return int(match[2]), column


def serialize(root, original):
    # Keep namespace declarations also used by mc:Ignorable attribute values.
    namespaces={prefix:uri for _,(prefix,uri) in ET.iterparse(io.BytesIO(original),events=['start-ns'])}
    for prefix,uri in namespaces.items():
        if not re.fullmatch(r'ns\d+',prefix):ET.register_namespace(prefix,uri)
    rendered=ET.tostring(root,encoding='utf-8',xml_declaration=True)
    for prefix,uri in namespaces.items():
        name='xmlns'+(':'+prefix if prefix else '')
        if (name+'=').encode() not in rendered:root.set(name,uri)
    return ET.tostring(root,encoding='utf-8',xml_declaration=True)


def workbook(files, sheet):
    book = xml(files['xl/workbook.xml'])
    relationships = {item.get('Id'): item.get('Target', '') for item in xml(files['xl/_rels/workbook.xml.rels'])}
    sheets = book.findall(S + 'sheets/' + S + 'sheet')
    if not 1 <= len(sheets) <= 32 or len({item.get('name') for item in sheets}) != len(sheets):
        raise ValueError('Unsupported sheet count or duplicate sheet names')
    names = [item.get('name', '') for item in sheets]
    selected = next((item for item in sheets if item.get('name') == (sheet or names[0])), None)
    if selected is None:
        raise ValueError('Choose an existing sheet name')
    target = relationships.get(selected.get(R + 'id'), '')
    if not target or '..' in PurePosixPath(target).parts or '\\' in target or ':' in target:
        raise ValueError('Unsafe worksheet relationship')
    path = target.lstrip('/') if target.startswith('/') else 'xl/' + target
    if not path.startswith('xl/worksheets/') or path not in files:
        raise ValueError('Unsupported worksheet path')
    shared = []
    if 'xl/sharedStrings.xml' in files:
        shared = [''.join(node.itertext()) for node in xml(files['xl/sharedStrings.xml'])]
        if len(shared) > 20000:
            raise ValueError('Shared string limit exceeded')
    tree = xml(files[path])
    cells = {}
    for cell in tree.iter(S + 'c'):
        ref = cell.get('r', '')
        address(ref)
        if ref in cells or len(cells) >= 20000:
            raise ValueError('Duplicate cells or worksheet cell limit exceeded')
        cells[ref] = cell
    return book, tree, path, cells, shared, names, selected.get('name')


def cell_value(cell, shared):
    if cell is None:
        return {'value': None, 'formula': None}
    formula, value = cell.find(S + 'f'), cell.find(S + 'v')
    text = value.text if value is not None else None
    kind = cell.get('t')
    if kind == 's':
        if text is None or not text.isdigit() or int(text) >= len(shared):
            raise ValueError('Invalid shared string index')
        text = shared[int(text)]
    elif kind == 'inlineStr':
        text = ''.join(node.text or '' for node in cell.iter(S + 't'))
    return {'value': text, 'formula': '=' + (formula.text or '') if formula is not None else None,
            'value_type': kind or 'n'}


def protect_cells(cells,shared):
    from jan_mcp_commander.privacy import assert_public_text,sensitive_label
    prior=None
    headers={}
    for ref in sorted(cells,key=address):
        value=cell_value(cells[ref],shared)
        column=address(ref)[1]
        assert_public_text(value.get('value') or '')
        assert_public_text(value.get('formula') or '')
        populated=value.get('value') not in (None,'') or bool(value.get('formula'))
        if column in headers and populated:
            assert_public_text(headers[column]+'='+json.dumps(value.get('value') or value.get('formula')))
        if sensitive_label(value.get('value')):
            headers[column]=value['value']
        if prior and address(ref)[0]==address(prior[0])[0]:
            assert_public_text(str(prior[1] or '')+'='+str(value.get('value') or ''))
        prior=(ref,value.get('value'))


def changeset(changes):
    from jan_mcp_commander.privacy import assert_public_text
    if not isinstance(changes, list) or not 1 <= len(changes) <= 50:
        raise ValueError('Choose 1..50 exact cell changes')
    seen = set()
    for change in changes:
        if not isinstance(change, dict) or set(change) not in ({'cell', 'value'}, {'cell', 'formula'}):
            raise ValueError('Each change needs cell and exactly one value or formula')
        ref = change['cell']
        address(ref)
        if ref in seen:
            raise ValueError('Duplicate cell changes denied')
        seen.add(ref)
        if 'formula' in change:
            formula = change['formula']
            assert_public_text(formula)
            if (not isinstance(formula, str) or not 2 <= len(formula) <= 1024 or not formula.startswith('=')
                    or not re.fullmatch(r'[A-Za-z0-9_$.,:+*/^() <>=-]+', formula[1:])
                    or any(name.upper() not in {'SUM','AVERAGE','MIN','MAX','COUNT','ROUND','IF','ABS'}
                           for name in re.findall(r'([A-Za-z_][A-Za-z0-9_.]*)\s*\(', formula))):
                raise ValueError('Only bounded local arithmetic and approved formulas are supported')
        else:
            value = change['value']
            assert_public_text(value)
            if (type(value) not in {str, int, float, bool, type(None)} or
                    isinstance(value, str) and (len(value) > 4096 or any(ord(c) < 32 and c not in '\t\n\r' for c in value)) or
                    type(value) in {int, float} and (not math.isfinite(value) or abs(value) > 1e100)):
                raise ValueError('Use bounded plain text, finite numbers, booleans or null')
    return changes


def parse(data, options):
    from jan_mcp_commander.privacy import assert_public_text
    files = package(data)
    start, count = options.get('start_row', 1), options.get('max_rows', 50)
    if type(start) is not int or not 1 <= start <= 1048576 or type(count) is not int or not 1 <= count <= 100:
        raise ValueError('Use start_row >= 1 and max_rows of 1..100')
    if options['kind'] == 'docx':
        if options.get('changes') is not None:
            raise ValueError('Word inspection is read-only')
        from jan_mcp_commander.document_formats import docx_model
        model=docx_model(data)
        paragraphs = [record['text'] for record in model['locations']]
        for paragraph in paragraphs:assert_public_text(paragraph)
        selected, size = [], 0
        for text in paragraphs[start-1:start-1+count]:
            if size + len(text.encode()) > 24576:
                break
            selected.append(text[:2048])
            size += len(text.encode())
        next_row = start + len(selected)
        tables=model['tables']
        if len(json.dumps(tables).encode())>24576:tables=[]
        return {'kind': 'docx', 'paragraphs': selected, 'locations':model['locations'][start-1:start-1+len(selected)],
                'tables':tables,'tables_truncated':bool(model['tables']) and not tables,'paragraph_count': len(paragraphs),
                'start_row': start, 'next_row': next_row if next_row <= len(paragraphs) else None,
                'formatting_inspected': True,'location_scope':'Stable within this source SHA-256'}
    book, tree, path, cells, shared, names, selected = workbook(files, options.get('sheet', ''))
    changes = options.get('changes')
    if changes is None:
        rows, size, limited_row = [], 0, None
        for ref in sorted(cells, key=address):
            if not start <= address(ref)[0] < start + count:
                continue
            value = cell_value(cells[ref], shared)
            value = {key: text[:2048] if isinstance(text, str) else text for key, text in value.items()}
            size += len(json.dumps(value).encode())
            if len(rows) >= 200 or size > 24576:
                limited_row=address(ref)[0]
                break
            rows.append({'cell': ref, **value})
        last_row = max((address(ref)[0] for ref in cells), default=0)
        return {'kind': 'xlsx', 'sheets': names, 'sheet': selected, 'cells': rows, 'start_row': start,
                'next_row': (limited_row if limited_row>start else None) if limited_row else start+count if start+count <= last_row else None,
                'truncated':limited_row is not None,'limited_at_row':limited_row,'formula_evaluation': False,
                'bounded': True}
    changeset(changes)
    if book.find(S+'definedNames') is not None:
        raise ValueError('Named ranges are read-only in this editor')
    for name,content in files.items():
        if name.startswith('xl/worksheets/') and name.endswith('.xml'):
            for formula in xml(content).iter(S+'f'):
                if formula.attrib:raise ValueError('Shared or array formulas are read-only')
                changeset([{'cell':'A1','formula':'='+(formula.text or '')}])
    if any(name.startswith('xl/tables/') for name in files) or tree.find(S + 'sheetProtection') is not None:
        raise ValueError('Table-backed or protected spreadsheets cannot be edited')
    if tree.find(S + 'mergeCells') is not None:
        raise ValueError('Merged-cell spreadsheets are read-only in this editor')
    preview = []
    sheet_data = tree.find(S + 'sheetData')
    if sheet_data is None:
        raise ValueError('Missing worksheet data')
    for change in changes:
        ref, cell = change['cell'], cells.get(change['cell'])
        if cell is not None and cell.find(S + 'f') is not None and cell.find(S + 'f').attrib:
            raise ValueError('Shared or array formulas are read-only')
        before=cell_value(cell,shared)
        if any(isinstance(value,str) and len(value)>4096 for value in before.values()):
            raise ValueError('Cell content exceeds the edit preview limit')
        preview.append({'cell': ref, 'before': before, 'after': {k:v for k,v in change.items() if k!='cell'}})
        if cell is None:
            number = address(ref)[0]
            row = next((r for r in sheet_data if r.get('r') == str(number)), None)
            if row is None:
                row = ET.SubElement(sheet_data, S + 'row', {'r': str(number)})
            cell = ET.SubElement(row, S + 'c', {'r': ref})
        for child in list(cell):
            if child.tag in {S+'v', S+'is', S+'f'}:
                cell.remove(child)
        cell.attrib.pop('t', None)
        if 'formula' in change:
            ET.SubElement(cell, S + 'f').text = change['formula'][1:]
        elif isinstance(change['value'], str):
            cell.set('t', 'inlineStr')
            ET.SubElement(ET.SubElement(cell, S+'is'), S+'t', {'{http://www.w3.org/XML/1998/namespace}space':'preserve'}).text = change['value']
        elif change['value'] is not None:
            value = change['value']
            if type(value) is bool:
                cell.set('t', 'b')
                value = int(value)
            ET.SubElement(cell, S+'v').text = str(value)
    for row in sheet_data:
        row[:] = sorted(row, key=lambda node: address(node.get('r', 'A1')) if node.tag == S+'c' else (1048577,0))
    sheet_data[:] = sorted(sheet_data, key=lambda row: int(row.get('r', '1')))
    protect_cells({cell.get('r',''):cell for cell in tree.iter(S+'c')},shared)
    calc = book.find(S+'calcPr')
    if calc is None:
        calc = ET.SubElement(book, S+'calcPr')
    calc.set('fullCalcOnLoad','1');calc.set('forceFullCalc','1')
    files[path] = serialize(tree,files[path])
    files['xl/workbook.xml'] = serialize(book,files['xl/workbook.xml'])
    for relpath in ('xl/_rels/workbook.xml.rels','[Content_Types].xml'):
        root = xml(files[relpath])
        for entry in list(root):
            if 'calcchain' in (entry.get('Type','') + entry.get('PartName','')).casefold():
                root.remove(entry)
        files[relpath] = serialize(root,files[relpath])
    files.pop('xl/calcChain.xml',None)
    result = {'kind':'xlsx','sheet':selected,'changes':preview,'dry_run':options.get('dry_run',True),
              'formula_evaluation':False,'recalculation_required':True}
    if not result['dry_run']:
        output=io.BytesIO()
        with ZipFile(output,'w',ZIP_DEFLATED) as archive:
            for name,content in files.items():archive.writestr(name,content)
        if output.tell()>MAX_FILE:raise ValueError('Edited Office document exceeds size limit')
        result['data']=base64.b64encode(output.getvalue()).decode('ascii')
    return result


def process_office(tree, path, **options):
    from .environment import runtime_environment
    from .security_scan import scan_bytes
    kind=Path(path).suffix.casefold().lstrip('.') if isinstance(path,str) else ''
    if kind not in {'xlsx','docx'}:raise ValueError('Choose a DOCX or XLSX workspace file')
    encoded_options=json.dumps({**options,'kind':kind})
    if len(encoded_options.encode())>16384:raise ValueError('Office options exceed the review limit; use fewer changes')
    data=tree.read(path,MAX_FILE)
    scan=scan_bytes(data,'.'+kind)
    try:
        reply=subprocess.run([sys.executable,'-I',str(Path(__file__)),encoded_options],
                             input=data,stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,timeout=10,
                             env=runtime_environment(),**({'creationflags':subprocess.CREATE_NO_WINDOW} if os.name=='nt' else {}))
    except subprocess.TimeoutExpired as exc:
        raise ValueError('Office processing timed out; no output saved') from exc
    if reply.returncode or len(reply.stdout)>MAX_FILE*2:raise ValueError('Office processor resource limit exceeded')
    result=json.loads(reply.stdout)
    if result.get('error'):raise ValueError(result['error'])
    if 'data' in result:
        result['bytes']=base64.b64decode(result.pop('data'),validate=True)
        if len(result['bytes'])>MAX_FILE:raise ValueError('Office output limit exceeded')
    return {**result,'path':path,'sha256':hashlib.sha256(data).hexdigest(),'security_scan':scan}


if __name__=='__main__':
    try:
        from jan_mcp_commander.worker_limits import apply_limits
        job=apply_limits(384)
        payload=sys.stdin.buffer.read(MAX_FILE+1)
        result=parse(payload,json.loads(sys.argv[1]))
    except (ValueError,KeyError,IndexError,ET.ParseError) as error:
        result={'error':str(error)[:240]}
    except Exception:
        result={'error':'Unsupported, malformed or oversized Office document; no output saved'}
    print(json.dumps(result,ensure_ascii=True))
