import hashlib
import io
import json
from zipfile import ZipFile,ZIP_DEFLATED
import pytest
from jan_mcp_commander.privacy import sensitive_text,assert_public_text,RULES
from jan_mcp_commander.safe_fs import unsupported_content
from jan_mcp_commander.control import ControlCommander
from jan_mcp_commander.core import PermissionDenied
from jan_mcp_commander import office_documents as office


@pytest.mark.parametrize('text',[
    'password=synthetic-password-only', 'PIN: 8264', 'PIN number 8264', 'OTP is 827461', 'OTP=827461', 'cvv: 734',
    'password="x"', 'pin=1',
    '{"password":"None"}', 'api_key: synthetic-key-only', 'token=synthetic-test-token',
    '-----BEGIN OPENSSH PRIVATE KEY-----', 'ghp_'+'a'*36, 'github_pat_'+'b'*50,
    'Bearer '+'c'*36, 'sk-live-'+'d'*36,
    '4111 1111 1111 1111', '4242424242424242', 'Aadhaar: 2345 6789 0123',
    'PAN: ABCDE1234F', 'SSN: 123-45-6789', 'password="function()"',
])
def test_high_confidence_private_text_is_blocked_without_echo(text):
    assert sensitive_text(text) and unsupported_content(text.encode())
    with pytest.raises(ValueError) as error:assert_public_text(text)
    assert str(error.value)==RULES['error'] and text not in str(error.value)


@pytest.mark.parametrize('text',[
    'password', 'Password field', 'def set_password(value): pass', 'password = None',
    'password: str', 'password = get_password()', 'token = None', 'api_key = os.getenv(KEY)',
    '{"password":{"type":"string"}}', 'order=12345678', 'Revenue 2026: 120000',
    '4111111111111112', 'lease_token', 'task_id=123456',
    'PAN camera left', '123-45-6789', 'ABCDE1234F', '2345 6789 0123',
])
def test_ordinary_labels_types_routing_fields_and_unlabeled_numbers_are_not_claimed_private(text):
    assert not sensitive_text(text)
    assert assert_public_text(text)==text


@pytest.fixture
def command(tmp_path,monkeypatch):
    work=tmp_path/'work';work.mkdir()
    monkeypatch.setenv('JAN_MCP_STATE_DIR',str(tmp_path/'private'))
    monkeypatch.setattr('jan_mcp_commander.security_scan.scan_bytes',lambda *a,**k:{'result':'synthetic_clean'})
    commander=ControlCommander(work,enabled={'files'})
    yield commander
    commander.close_control()


def test_text_reads_writes_search_and_preview_do_not_expose_private_values(command):
    secret='password=synthetic-private-test'
    (command.workspace/'notes.txt').write_text(secret)
    with pytest.raises(PermissionDenied):command.read_text('notes.txt')
    with pytest.raises(PermissionDenied):command.file_info('notes.txt')
    assert command.search_text('synthetic')['matches']==[]
    with pytest.raises(ValueError):command.search_text(secret)
    before=(command.workspace/'notes.txt').read_bytes()
    for action in [lambda:command.write_text('new.txt',secret),lambda:command.write_text('notes.txt','ordinary replacement',True),
                   lambda:command.delete_text('notes.txt',hashlib.sha256(before).hexdigest()),
                   lambda:command.move_text('notes.txt','copied.txt',hashlib.sha256(before).hexdigest())]:
        with pytest.raises(ValueError):action()
    assert not (command.workspace/'new.txt').exists() and not (command.workspace/'copied.txt').exists()
    assert (command.workspace/'notes.txt').read_bytes()==before
    command.write_text('public.txt','pass-PLACEHOLDER')
    digest=hashlib.sha256(b'pass-PLACEHOLDER').hexdigest()
    with pytest.raises(ValueError):command.edit_text('public.txt','-PLACEHOLDER','word=synthetic-private',digest)
    assert (command.workspace/'public.txt').read_text()=='pass-PLACEHOLDER'
    assert secret not in command.audit_path.read_text()


def test_denied_sensitive_filename_is_not_copied_to_audit(command):
    secret_path='password=synthetic-private-path.txt'
    with pytest.raises(ValueError):command.read_text(secret_path)
    assert secret_path not in command.audit_path.read_text()


def test_process_output_slices_and_sensitive_input_cannot_bypass_policy(tmp_path,monkeypatch):
    import threading
    from types import SimpleNamespace
    monkeypatch.setenv('JAN_MCP_STATE_DIR',str(tmp_path/'private'))
    work=tmp_path/'workspace';work.mkdir()
    command=ControlCommander(work,enabled={'commands','desktop'})
    try:
        done=threading.Event();done.set()
        command._sessions['synthetic']={'profile':'operator_command','output':bytearray(b'ordinary\npassword=synthetic-private-process'),'process':SimpleNamespace(poll=lambda:0),'done':done,'truncated':False,'timed_out':False}
        with pytest.raises(ValueError):command.process_output('synthetic',offset=0,length=4)
        with pytest.raises(ValueError):command.process_input('synthetic','PIN: 8264')
        with pytest.raises(ValueError):command.start_process('echo password=synthetic-private-process')
        with pytest.raises(ValueError):command.desktop_action('type',text='OTP=827461')
    finally:
        command._sessions.clear();command.close_control()


def archive(files):
    data=io.BytesIO()
    with ZipFile(data,'w',ZIP_DEFLATED) as package:
        for name,text in files.items():package.writestr(name,text)
    return data.getvalue()


def spreadsheet(first='Revenue',second='ordinary'):
    return archive({'[Content_Types].xml':'<Types/>',
        'xl/workbook.xml':f'<workbook xmlns="{office.S[1:-1]}" xmlns:r="{office.R[1:-1]}"><sheets><sheet name="Sheet1" r:id="r1"/></sheets></workbook>',
        'xl/_rels/workbook.xml.rels':'<Relationships><Relationship Id="r1" Target="worksheets/sheet1.xml"/></Relationships>',
        'xl/worksheets/sheet1.xml':f'<worksheet xmlns="{office.S[1:-1]}"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>{first}</t></is></c><c r="B1" t="inlineStr"><is><t>{second}</t></is></c></row></sheetData></worksheet>'})


def test_office_content_and_proposed_cells_fail_before_read_or_copy(command):
    data=spreadsheet('Password','synthetic-only')
    (command.workspace/'private.xlsx').write_bytes(data)
    for action in [lambda:command.inspect_office('private.xlsx'),lambda:command.edit_spreadsheet('private.xlsx','Sheet1',[{'cell':'B1','value':'replacement'}],hashlib.sha256(data).hexdigest(),False),
                   lambda:command._write_binary('copy.xlsx',data)]:
        with pytest.raises(ValueError) as error:action()
        assert 'synthetic-only' not in str(error.value)
    assert not (command.workspace/'copy.xlsx').exists()
    ordinary=spreadsheet();(command.workspace/'public.xlsx').write_bytes(ordinary)
    digest=hashlib.sha256(ordinary).hexdigest()
    with pytest.raises(ValueError):command.preview_spreadsheet('public.xlsx','Sheet1',[{'cell':'B1','value':'otp=827461'}],digest)
    with pytest.raises(ValueError):command.edit_spreadsheet('public.xlsx','Sheet1',[{'cell':'A1','value':'Password'}],digest,False)
    assert (command.workspace/'public.xlsx').read_bytes()==ordinary
    doc=archive({'word/document.xml':f'<w:document xmlns:w="{office.W[1:-1]}"><w:p><w:r><w:t>pass</w:t></w:r><w:r><w:t>word=synthetic-only</w:t></w:r></w:p></w:document>'})
    (command.workspace/'private.docx').write_bytes(doc)
    with pytest.raises(ValueError):command.inspect_office('private.docx')


def column_spreadsheet(header='Password',value='synthetic-column-secret'):
    with ZipFile(io.BytesIO(spreadsheet(header,value))) as source:
        files={name:source.read(name) for name in source.namelist()}
    files['xl/worksheets/sheet1.xml']=files['xl/worksheets/sheet1.xml'].replace(b'<c r="B1"',b'</row><row r="2"><c r="A2"')
    return archive(files)


def test_sensitive_column_header_protects_later_rows_copy_and_proposals(command):
    data=column_spreadsheet();(command.workspace/'column.xlsx').write_bytes(data)
    for action in [lambda:command.inspect_office('column.xlsx'),lambda:command._write_binary('copy-column.xlsx',data)]:
        with pytest.raises(ValueError) as error:action()
        assert 'synthetic-column-secret' not in str(error.value)
    assert not (command.workspace/'copy-column.xlsx').exists()
    ordinary=column_spreadsheet('Revenue','ordinary');(command.workspace/'public-column.xlsx').write_bytes(ordinary)
    assert command.inspect_office('public-column.xlsx')['kind']=='xlsx'
    for dry_run in (True,False):
        with pytest.raises(ValueError):command.edit_spreadsheet('public-column.xlsx','Sheet1',[{'cell':'A1','value':'Password'}],hashlib.sha256(ordinary).hexdigest(),dry_run)
    assert (command.workspace/'public-column.xlsx').read_bytes()==ordinary


def hex_pdf(text):
    from pypdf import PdfWriter
    from pypdf.generic import DecodedStreamObject,DictionaryObject,NameObject
    writer=PdfWriter();page=writer.add_blank_page(300,200)
    font=DictionaryObject({NameObject('/Type'):NameObject('/Font'),NameObject('/Subtype'):NameObject('/Type1'),NameObject('/BaseFont'):NameObject('/Helvetica')})
    page[NameObject('/Resources')]=DictionaryObject({NameObject('/Font'):DictionaryObject({NameObject('/F1'):writer._add_object(font)})})
    stream=DecodedStreamObject();stream.set_data(b'BT /F1 12 Tf 20 100 Td <'+text.encode().hex().encode()+b'> Tj ET')
    page[NameObject('/Contents')]=writer._add_object(stream)
    output=io.BytesIO();writer.write(output);return output.getvalue()


def test_sensitive_decoded_pdf_blocks_legacy_restore_copy_and_overwrite(command):
    private=hex_pdf('password=synthetic-legacy-private')
    assert b'password=' not in private
    with command._store.locked():backup=command._store.backup('legacy.pdf',private,binary=True)
    with pytest.raises(ValueError):command.restore_backup(backup)
    assert not (command.workspace/'legacy.pdf').exists()
    with pytest.raises(ValueError):command._write_binary('copy.pdf',private)
    assert not (command.workspace/'copy.pdf').exists()
    (command.workspace/'existing.pdf').write_bytes(private)
    with pytest.raises(ValueError):command._write_binary('existing.pdf',hex_pdf('Ordinary PDF'),overwrite=True,expected_sha256=hashlib.sha256(private).hexdigest())
    assert (command.workspace/'existing.pdf').read_bytes()==private


@pytest.mark.parametrize('text',[
    '{"password":{"value":"synthetic-nested-private"}}',
    '{"api_key":[{"value":"synthetic-nested-private"}]}',
    '{"password":{"value":"synthetic-nested-private"},"password":null}',
    '{"\\u0070assword":{"value":"synthetic-nested-private"}}',
    json.dumps(json.dumps({'password':{'value':'synthetic-nested-private'}})),
])
def test_nested_serialized_credentials_preserve_label_context(text):
    assert sensitive_text(text)
    with pytest.raises(ValueError) as error:assert_public_text(text)
    assert 'synthetic-nested-private' not in str(error.value)


def test_schema_type_for_password_is_not_a_credential():
    assert not sensitive_text('{"password":{"type":"string"}}')
    assert not sensitive_text('{"password":null}')
    assert not sensitive_text('{"order":{"value":123456789}}')

@pytest.mark.parametrize('text',[
    "{'password': {'value': 'synthetic-private-fixture'}}",
    "{'password': ['synthetic-private-fixture']}",
    "{'aadhaar': {'number': '234567891234'}}",
    "{'outer': {'password': {'value': 'synthetic-private-fixture'}}, 'outer': None}",
])
def test_python_repr_nested_credentials_are_blocked_without_execution(text):
    assert sensitive_text(text)
    with pytest.raises(ValueError) as error:assert_public_text(text)
    assert 'synthetic-private-fixture' not in str(error.value)


@pytest.mark.parametrize('text',[
    "{'password': {'type': 'string'}}", "{'password': {'type': str}}",
    "{'password': {'value': some_symbol}}", "{'password': {'value': helper()}}",
    "{'ordinary': {'value': 'hello'}, 'enabled': True, 'optional': None}",
])
def test_python_repr_schema_and_symbolic_code_are_not_evaluated_or_claimed_private(text):
    assert not sensitive_text(text)
