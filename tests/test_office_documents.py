import base64
import hashlib
import io
from zipfile import ZipFile,ZIP_DEFLATED
import pytest
from jan_mcp_commander import office_documents as office
from jan_mcp_commander.control import ControlCommander,CONTROL_METHODS,READ_TOOLS
from jan_mcp_commander.core import PermissionDenied


def bundle(files):
    out=io.BytesIO()
    with ZipFile(out,'w',ZIP_DEFLATED) as archive:
        for name,text in files.items():archive.writestr(name,text)
    return out.getvalue()


def xlsx(extra=None):
    files={'[Content_Types].xml':'<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/xl/calcChain.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.calcChain+xml"/></Types>',
           'xl/workbook.xml':f'<workbook xmlns="{office.S[1:-1]}" xmlns:r="{office.R[1:-1]}"><sheets><sheet name="Budget" sheetId="1" r:id="rId1"/></sheets></workbook>',
           'xl/_rels/workbook.xml.rels':f'<Relationships xmlns="{office.P[1:-1]}"><Relationship Id="rId1" Target="worksheets/sheet1.xml"/><Relationship Id="rCalc" Target="calcChain.xml" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/calcChain"/></Relationships>',
           'xl/worksheets/sheet1.xml':f'<worksheet xmlns="{office.S[1:-1]}" xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006" xmlns:x14ac="http://schemas.microsoft.com/office/spreadsheetml/2009/9/ac" mc:Ignorable="x14ac"><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1"><v>12</v></c></row><row r="2"><c r="A2" t="inlineStr"><is><t>Costs</t></is></c><c r="B2"><v>5</v></c></row><row r="3"><c r="B3"><f>SUM(B1:B2)</f><v>17</v></c></row></sheetData></worksheet>',
           'xl/sharedStrings.xml':f'<sst xmlns="{office.S[1:-1]}"><si><t>Revenue</t></si></sst>',
           'xl/calcChain.xml':f'<calcChain xmlns="{office.S[1:-1]}"/>'}
    files.update(extra or {})
    return bundle(files)


@pytest.mark.skipif(office.os.name!='nt',reason='Windows antivirus wrapper integration')
@pytest.mark.parametrize('kind',['docx','xlsx'])
def test_office_wrapper_keeps_real_scan_validation_before_parser(tmp_path,monkeypatch,kind):
    import json
    from types import SimpleNamespace
    from jan_mcp_commander.safe_fs import SafeTree
    payload=xlsx() if kind=='xlsx' else bundle({'word/document.xml':f'<w:document xmlns:w="{office.W[1:-1]}"><w:body><w:p><w:r><w:t>Synthetic Word document</w:t></w:r></w:p></w:body></w:document>'})
    name='fixture.'+kind;(tmp_path/name).write_bytes(payload)
    calls=[]
    def run(argv,**kwargs):
        calls.append(argv)
        if argv[0].lower().endswith('powershell.exe'):
            value={'AMServiceEnabled':True,'AntivirusEnabled':True,'RealTimeProtectionEnabled':True,'AntivirusSignatureAge':0}
        elif argv[-2].endswith('_security_scan_worker.py'):
            assert argv[-1]=='.'+kind and kwargs['input']==payload
            value={'hresult':0,'result':0}
        else:
            assert argv[-2].endswith('office_documents.py') and kwargs['input']==payload
            value=office.parse(payload,json.loads(argv[-1]))
        return SimpleNamespace(returncode=0,stdout=json.dumps(value).encode())
    monkeypatch.setattr(office.subprocess,'run',run)
    result=office.process_office(SafeTree(tmp_path),name)
    assert result['kind']==kind and result['security_scan']['result']=='no_detection'
    assert len(calls)==3


def test_docx_and_xlsx_inspection_are_bounded_without_execution():
    data=bundle({'word/document.xml':f'<w:document xmlns:w="{office.W[1:-1]}"><w:body><w:p><w:r><w:t>First paragraph</w:t></w:r></w:p><w:tbl><w:tr><w:tc><w:p><w:r><w:t>Table cell</w:t></w:r></w:p></w:tc></w:tr></w:tbl></w:body></w:document>'})
    first=office.parse(data,{'kind':'docx','max_rows':1})
    assert first['paragraphs']==['First paragraph'] and first['next_row']==2
    second=office.parse(data,{'kind':'docx','start_row':2})
    assert second['paragraphs']==['Table cell'] and second['next_row'] is None
    result=office.parse(xlsx(),{'kind':'xlsx','sheet':'Budget','start_row':2,'max_rows':2})
    assert result['sheets']==['Budget'] and result['formula_evaluation'] is False
    assert next(c for c in result['cells'] if c['cell']=='B3')['formula']=='=SUM(B1:B2)'
    assert next(c for c in result['cells'] if c['cell']=='A2')['value']=='Costs'


def test_exact_spreadsheet_preview_apply_formula_namespace_and_cell_order():
    changes=[{'cell':'B1','value':25},{'cell':'B3','formula':'=SUM(B1:B2)'},{'cell':'C1','value':'=HYPERLINK("unsafe")'},{'cell':'A4','value':True}]
    options={'kind':'xlsx','sheet':'Budget','changes':changes,'dry_run':True}
    preview=office.parse(xlsx(),options)
    assert 'data' not in preview and preview['dry_run']
    assert preview['changes'][0]['before']['value']=='12'
    assert preview['changes'][0]['after']=={'value':25}
    result=office.parse(xlsx(),{**options,'dry_run':False})
    data=base64.b64decode(result['data'])
    inspected=office.parse(data,{'kind':'xlsx'})
    assert next(c for c in inspected['cells'] if c['cell']=='B1')['value']=='25'
    assert next(c for c in inspected['cells'] if c['cell']=='C1')['value']=='=HYPERLINK("unsafe")'
    assert next(c for c in inspected['cells'] if c['cell']=='C1')['formula'] is None
    files=office.package(data)
    assert 'xl/calcChain.xml' not in files and b'calcChain' not in files['[Content_Types].xml']
    assert b'xmlns:x14ac=' in files['xl/worksheets/sheet1.xml']
    assert b'fullCalcOnLoad="1"' in files['xl/workbook.xml']
    assert result['recalculation_required'] and not result['formula_evaluation']


@pytest.mark.parametrize('extra',[
    {'../outside.xml':'<x/>'},
    {'xl/vbaProject.bin':b'dummy'},
    {'xl/activeX/activeX1.xml':'<x/>'},
    {'word/_rels/document.xml.rels':f'<Relationships xmlns="{office.P[1:-1]}"><Relationship Id="x" Target="https://evil.invalid" TargetMode="External"/></Relationships>'},
    {'unsafe.xml':'<!DOCTYPE x [<!ENTITY boom "unsafe">]><x>&boom;</x>'},
    {'unsafe.xml':'<!DOCTYPE x [<!ENTITY boom "unsafe">]><x>&boom;</x>'.encode('utf-16')},
    {'bomb.xml':'x'*1000000},
])
def test_untrusted_packages_fail_closed(extra):
    with pytest.raises((ValueError,UnicodeDecodeError)):
        office.parse(xlsx(extra),{'kind':'xlsx'})


@pytest.mark.parametrize('changes',[
    [{'cell':'A1','formula':'=WEBSERVICE(A2)'}],
    [{'cell':'A1','formula':'=HYPERLINK(A2)'}],
    [{'cell':'A1','formula':"='[outside.xlsx]Sheet1'!A1"}],
    [{'cell':'A1','value':float('inf')}],
    [{'cell':'XFE1','value':1}],
    [{'cell':'A0','value':1}],
    [{'cell':'A1','value':1},{'cell':'A1','value':2}],
    [{'cell':'A1','value':1,'formula':'=1'}],
])
def test_invalid_or_external_formula_changes_are_rejected(changes):
    with pytest.raises(ValueError):office.parse(xlsx(),{'kind':'xlsx','changes':changes})


def test_unsafe_existing_formulas_tables_and_protection_are_read_only():
    source=office.package(xlsx())
    for changed in [
        {'xl/tables/table1.xml':'<table/>'},
        {'xl/worksheets/sheet1.xml':source['xl/worksheets/sheet1.xml'].replace(b'SUM(B1:B2)',b'WEBSERVICE(A1)')},
        {'xl/worksheets/sheet1.xml':source['xl/worksheets/sheet1.xml'].replace(b'</worksheet>',b'<sheetProtection/></worksheet>')},
    ]:
        data=bundle({**source,**changed})
        assert office.parse(data,{'kind':'xlsx'})['kind']=='xlsx'
        with pytest.raises(ValueError):office.parse(data,{'kind':'xlsx','changes':[{'cell':'B1','value':1}]})


def test_control_uses_safe_tree_hash_backup_and_expiry(tmp_path,monkeypatch):
    work=tmp_path/'work';work.mkdir()
    monkeypatch.setenv('JAN_MCP_STATE_DIR',str(tmp_path/'private'))
    monkeypatch.setattr('jan_mcp_commander.security_scan.scan_bytes',lambda *args,**kwargs:{'result':'synthetic_clean'})
    original=xlsx();(work/'budget.xlsx').write_bytes(original)
    command=ControlCommander(work,enabled={'files'})
    try:
        inspection=command.inspect_office('budget.xlsx')
        assert inspection['sha256']==hashlib.sha256(original).hexdigest()
        preview=command.edit_spreadsheet('budget.xlsx','Budget',[{'cell':'B1','value':33}],inspection['sha256'])
        assert preview['dry_run'] and (work/'budget.xlsx').read_bytes()==original
        with pytest.raises(PermissionDenied,match='changed'):
            command.edit_spreadsheet('budget.xlsx','Budget',[{'cell':'B1','value':33}],'0'*64,False)
        applied=command.edit_spreadsheet('budget.xlsx','Budget',[{'cell':'B1','value':33}],inspection['sha256'],False)
        assert applied['backup_id'] and applied['source_sha256']==inspection['sha256']
        assert applied['sha256']!=inspection['sha256']
        command.restore_backup(applied['backup_id'])
        assert (work/'budget.xlsx').read_bytes()==original
        with pytest.raises(ValueError):command.inspect_office('../outside.xlsx')
        with pytest.raises(ValueError):command.inspect_office('.env.xlsx')
        command._disabled=True
        with pytest.raises(PermissionDenied):command.inspect_office('budget.xlsx')
    finally:
        command.close_control()
    assert 'jan_inspect_office' in READ_TOOLS
    assert CONTROL_METHODS['jan_edit_spreadsheet']=='edit_spreadsheet'


def test_oversized_review_and_failed_antivirus_never_reach_worker(tmp_path,monkeypatch):
    from jan_mcp_commander.safe_fs import SafeTree
    (tmp_path/'budget.xlsx').write_bytes(xlsx())
    monkeypatch.setattr(office.subprocess,'run',lambda *args,**kwargs:pytest.fail('worker must not start'))
    with pytest.raises(ValueError,match='review limit'):
        office.process_office(SafeTree(tmp_path),'budget.xlsx',changes=[{'cell':'A1','value':'x'*20000}])
    def denied(*args,**kwargs):raise ValueError('Synthetic antivirus unavailable')
    monkeypatch.setattr('jan_mcp_commander.security_scan.scan_bytes',denied)
    with pytest.raises(ValueError,match='antivirus unavailable'):
        office.process_office(SafeTree(tmp_path),'budget.xlsx')


def test_readonly_http_preview_cannot_be_switched_to_apply(tmp_path,monkeypatch):
    from starlette.testclient import TestClient
    from jan_mcp_commander.http_server import create_app,prepare_backend
    work=tmp_path/'work';work.mkdir()
    monkeypatch.setenv('JAN_MCP_STATE_DIR',str(tmp_path/'private'))
    monkeypatch.setattr('jan_mcp_commander.security_scan.scan_bytes',lambda *args,**kwargs:{'result':'synthetic_clean'})
    original=xlsx();(work/'budget.xlsx').write_bytes(original)
    commander=ControlCommander(work,enabled={'files'})
    _,token,_=prepare_backend(work,initialize=True)
    headers={'Authorization':'Bearer '+token,'Host':'localhost:8866','Accept':'application/json, text/event-stream'}
    arguments={'path':'budget.xlsx','sheet':'Budget','changes':[{'cell':'B1','value':99}],'expected_sha256':hashlib.sha256(original).hexdigest()}
    try:
        with TestClient(create_app(commander,token)) as client:
            result=client.post('/mcp',headers=headers,json={'jsonrpc':'2.0','id':1,'method':'tools/call','params':{'name':'jan_preview_spreadsheet','arguments':arguments}})
            assert result.status_code==200 and not result.json()['result'].get('isError'),result.text
            assert (work/'budget.xlsx').read_bytes()==original
            blocked=client.post('/mcp',headers=headers,json={'jsonrpc':'2.0','id':2,'method':'tools/call','params':{'name':'jan_edit_spreadsheet','arguments':{**arguments,'dry_run':False}}})
            assert blocked.status_code==403
            client.post('/mcp',headers=headers,json={'jsonrpc':'2.0','id':3,'method':'tools/call','params':{'name':'jan_preview_spreadsheet','arguments':{**arguments,'dry_run':False}}})
            assert (work/'budget.xlsx').read_bytes()==original
    finally:
        commander.close_control()
