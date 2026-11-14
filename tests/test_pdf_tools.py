import hashlib
import io
import json

import pytest
from pypdf import PdfReader, PdfWriter
from pypdf.generic import DecodedStreamObject, DictionaryObject, NameObject

from jan_mcp_commander.pdf_tools import process_pdf
from jan_mcp_commander.safe_fs import SafeTree


@pytest.fixture(autouse=True)
def scan(monkeypatch):
    monkeypatch.setattr('jan_mcp_commander.security_scan.scan_bytes', lambda data, suffix, **kwargs: {'result': 'synthetic_clean'})


def sample(text=b'PCRC PDF test'):
    writer = PdfWriter()
    page = writer.add_blank_page(300, 200)
    font = DictionaryObject({NameObject('/Type'): NameObject('/Font'), NameObject('/Subtype'): NameObject('/Type1'), NameObject('/BaseFont'): NameObject('/Helvetica')})
    page[NameObject('/Resources')] = DictionaryObject({NameObject('/Font'): DictionaryObject({NameObject('/F1'): writer._add_object(font)})})
    stream = DecodedStreamObject()
    stream.set_data(b'BT /F1 12 Tf 20 100 Td ('+text+b') Tj ET')
    page[NameObject('/Contents')] = writer._add_object(stream)
    out = io.BytesIO(); writer.write(out)
    return out.getvalue()


def test_sensitive_pdf_read_copy_and_creation_are_blocked(tmp_path):
    from jan_mcp_commander.pdf_tools import create_text_pdf
    private=b'password=synthetic-private-pdf'
    (tmp_path/'source.pdf').write_bytes(sample(private))
    tree=SafeTree(tmp_path)
    for options in ({},{'pages':[1]}):
        with pytest.raises(ValueError) as error:process_pdf(tree,'source.pdf',**options)
        assert private.decode() not in str(error.value)
    with pytest.raises(ValueError):create_text_pdf(private.decode())


def test_pdf_text_and_page_edit_without_word(tmp_path):
    data = sample(); (tmp_path/'source.pdf').write_bytes(data)
    tree = SafeTree(tmp_path)
    result = process_pdf(tree, 'source.pdf')
    assert 'PCRC PDF test' in result['text']
    assert result['sha256'] == hashlib.sha256(data).hexdigest()
    edited = process_pdf(tree, 'source.pdf', pages=[1], rotation=90)
    reader = PdfReader(io.BytesIO(edited['bytes']))
    assert len(reader.pages) == 1 and reader.pages[0].rotation == 90
    assert 'PCRC PDF test' in reader.pages[0].extract_text()
    assert (tmp_path/'source.pdf').read_bytes() == data


def test_pdf_invalid_paths_and_documents_fail_closed(tmp_path):
    tree = SafeTree(tmp_path)
    (tmp_path/'bad.pdf').write_bytes(b'not a PDF')
    (tmp_path/'source.pdf').write_bytes(sample())
    for path in ['../outside.pdf', '.env.pdf', 'bad.pdf']:
        with pytest.raises(ValueError): process_pdf(tree, path)
    for options in [{'pages': []}, {'pages': [0]}, {'pages': [2]}, {'rotation': 45}, {'pages': [True]}]:
        with pytest.raises(ValueError): process_pdf(tree, 'source.pdf', **options)
    writer = PdfWriter(); writer.add_blank_page(100, 100); writer.encrypt('synthetic')
    out = io.BytesIO(); writer.write(out); (tmp_path/'encrypted.pdf').write_bytes(out.getvalue())
    with pytest.raises(ValueError): process_pdf(tree, 'encrypted.pdf')


def test_pdf_timeout_does_not_return_partial_data(tmp_path, monkeypatch):
    import subprocess
    import jan_mcp_commander.pdf_tools as pdf
    (tmp_path/'source.pdf').write_bytes(sample())
    def timeout(*args, **kwargs): raise subprocess.TimeoutExpired(args[0], 10)
    monkeypatch.setattr(pdf.subprocess, 'run', timeout)
    with pytest.raises(ValueError, match='time limit'): process_pdf(SafeTree(tmp_path), 'source.pdf')


def test_pdf_scan_failure_stops_before_parser(tmp_path, monkeypatch):
    (tmp_path/'source.pdf').write_bytes(sample())
    def deny(*args, **kwargs): raise ValueError('Threat detected')
    def never(*args, **kwargs): pytest.fail('Parser must not start after failed scan')
    monkeypatch.setattr('jan_mcp_commander.security_scan.scan_bytes', deny)
    monkeypatch.setattr('jan_mcp_commander.pdf_tools.subprocess.run', never)
    with pytest.raises(ValueError, match='Threat detected'): process_pdf(SafeTree(tmp_path), 'source.pdf')


def test_pdf_write_hash_overwrite_and_binary_recovery(tmp_path, monkeypatch):
    from jan_mcp_commander.control import ControlCommander
    monkeypatch.setenv('JAN_MCP_STATE_DIR', str(tmp_path/'private'))
    work = tmp_path/'work'; work.mkdir()
    data = sample(); (work/'source.pdf').write_bytes(data)
    cmd = ControlCommander(work, enabled={'files'})
    try:
        digest = hashlib.sha256(data).hexdigest()
        with pytest.raises(ValueError): cmd.rewrite_pdf('source.pdf', 'wrong.pdf', '0'*64, [1])
        assert not (work/'wrong.pdf').exists()
        first = cmd.rewrite_pdf('source.pdf', 'new.pdf', digest, [1], 90)
        assert first['backup_id'] is None
        with pytest.raises(FileExistsError): cmd.rewrite_pdf('source.pdf', 'new.pdf', digest, [1])
        with pytest.raises(ValueError): cmd.rewrite_pdf('source.pdf', 'new.pdf', digest, [1], overwrite=True)
        with pytest.raises(ValueError): cmd.rewrite_pdf('source.pdf', 'new.pdf', digest, [1], overwrite=True, expected_destination_sha256='0'*64)
        previous = (work/'new.pdf').read_bytes()
        result = cmd.rewrite_pdf('source.pdf', 'new.pdf', digest, [1], 180, True, first['sha256'])
        assert result['backup_id'] and (work/'new.pdf').read_bytes() != previous
        cmd.restore_backup(result['backup_id'])
        assert (work/'new.pdf').read_bytes() == previous
        assert (work/'source.pdf').read_bytes() == data
    finally:
        cmd.close_control()
