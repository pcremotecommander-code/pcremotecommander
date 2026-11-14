"""Workspace-confined PDF operations; parsing runs in a bounded child process."""
import base64
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import time

from .environment import runtime_environment
from .worker_limits import remaining

MAX_PDF = 8 * 1024 * 1024


def process_pdf(tree, path, *, pages=None, rotation=0, deadline=None):
    deadline=time.monotonic()+15 if deadline is None else deadline
    if not isinstance(path, str) or not path.casefold().endswith('.pdf'):
        raise ValueError('Choose a relative PDF path')
    if type(rotation) is not int or rotation not in {0, 90, 180, 270}:
        raise ValueError('PDF rotation must be 0, 90, 180 or 270')
    if pages is not None and (not isinstance(pages, list) or not 1 <= len(pages) <= 50 or
                              any(type(p) is not int or not 1 <= p <= 50 for p in pages)):
        raise ValueError('Choose 1..50 one-based page numbers')
    data = tree.read(path, MAX_PDF)
    return {**inspect_pdf_bytes(data,pages=pages,rotation=rotation,deadline=deadline),'path':path,'sha256':hashlib.sha256(data).hexdigest()}


def inspect_pdf_bytes(data, *, pages=None, rotation=0, deadline=None):
    """Validate decoded PDF text before any raw binary copy, backup or restore."""
    deadline=time.monotonic()+15 if deadline is None else deadline
    if not isinstance(data,bytes) or len(data)>MAX_PDF:
        raise ValueError('PDF input size exceeded')
    if not data.startswith(b'%PDF-'):
        raise ValueError('Invalid PDF header')
    from .security_scan import scan_bytes
    scan = scan_bytes(data, '.pdf',deadline=deadline)
    worker = Path(__file__).with_name('_pdf_worker.py')
    try:
        result = subprocess.run([sys.executable, '-I', str(worker), json.dumps({'pages': pages, 'rotation': rotation})],
                                input=data, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                                timeout=remaining(deadline,10), env=runtime_environment(),
                                **({'creationflags': subprocess.CREATE_NO_WINDOW} if os.name == 'nt' else {}))
    except subprocess.TimeoutExpired as exc:
        raise ValueError('PDF processing exceeded its time limit; no output saved') from exc
    if result.returncode or len(result.stdout) > MAX_PDF * 2:
        raise ValueError('PDF processing denied, unavailable or exceeded resource limits; no output saved')
    remaining(deadline,15)
    value = json.loads(result.stdout)
    if value.get('error'):
        raise ValueError(value['error'])
    if pages is not None:
        value['bytes'] = base64.b64decode(value.pop('data'), validate=True)
        if len(value['bytes']) > MAX_PDF:
            raise ValueError('PDF output size exceeded')
    return {**value, 'security_scan': scan}


def create_text_pdf(text):
    from .privacy import assert_public_text
    assert_public_text(text)
    import io
    import textwrap
    from pypdf import PdfWriter
    from pypdf.generic import DecodedStreamObject, DictionaryObject, NameObject

    if not isinstance(text, str) or not text.strip() or len(text) > 16000:
        raise ValueError('PDF text must contain 1..16000 characters')
    if any(ord(char) < 32 and char not in '\r\n\t' for char in text):
        raise ValueError('PDF text contains unsupported control characters')
    lines = [segment for line in text.expandtabs(4).splitlines()
             for segment in (textwrap.wrap(line, width=76, replace_whitespace=False) or [''])]
    if len(lines) > 46 * 20:
        raise ValueError('PDF exceeds the 20-page limit')
    writer = PdfWriter()
    font = DictionaryObject({NameObject('/Type'): NameObject('/Font'),
                             NameObject('/Subtype'): NameObject('/Type1'),
                             NameObject('/BaseFont'): NameObject('/Courier'),
                             NameObject('/Encoding'): NameObject('/WinAnsiEncoding')})
    for offset in range(0, len(lines), 46):
        page = writer.add_blank_page(width=612, height=792)
        page[NameObject('/Resources')] = DictionaryObject({
            NameObject('/Font'): DictionaryObject({NameObject('/F1'): font})})
        try:
            encoded = [line.encode('cp1252').hex() for line in lines[offset:offset + 46]]
        except UnicodeEncodeError as exc:
            raise ValueError('Text contains characters outside the supported Windows-1252 font') from exc
        stream = DecodedStreamObject()
        stream.set_data(('BT /F1 11 Tf 15 TL 48 744 Td\n' +
                         '\n'.join(f'<{line}> Tj T*' for line in encoded) + '\nET').encode('ascii'))
        page.replace_contents(stream)
    with io.BytesIO() as output:
        writer.write(output)
        return output.getvalue(), len(writer.pages)


def main(argv=None, *, workspace=None):
    import argparse
    from .cli import workspace_path
    from .portable import PortableCommander
    parser = argparse.ArgumentParser(description='PCRC bounded PDF tools; originals preserved unless explicitly overwritten')
    actions = parser.add_subparsers(dest='action', required=True)
    read = actions.add_parser('read'); read.add_argument('path')
    write = actions.add_parser('rewrite'); write.add_argument('path'); write.add_argument('destination')
    write.add_argument('--pages', nargs='+', type=int, required=True)
    write.add_argument('--rotation', type=int, choices=[0,90,180,270], default=0)
    write.add_argument('--expected-sha256', required=True)
    write.add_argument('--overwrite', action='store_true')
    write.add_argument('--expected-destination-sha256')
    write.add_argument('--allow-writes', action='store_true')
    args = parser.parse_args(argv)
    try:
        cmd = PortableCommander(workspace_path(workspace))
        if args.action == 'read':
            result = cmd.read_pdf(args.path)
        else:
            cmd.allow_writes = args.allow_writes
            result = cmd.rewrite_pdf(args.path, args.destination, args.expected_sha256, args.pages,
                                     args.rotation, args.overwrite, args.expected_destination_sha256)
        print(json.dumps(result, ensure_ascii=True)); return 0
    except (ValueError, OSError) as exc:
        print(json.dumps({'error':str(exc)}, ensure_ascii=True)); return 1
