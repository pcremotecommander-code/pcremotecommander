"""Trusted worker entry point. Document bytes never become code or filesystem paths."""
import base64
import io
import json
import logging
import os
import sys


def main():
    from jan_mcp_commander.worker_limits import apply_limits
    job = apply_limits(512)
    logging.disable(logging.CRITICAL)
    from pypdf import PdfReader, PdfWriter
    import pypdf.filters as filters
    filters.ZLIB_MAX_OUTPUT_LENGTH = filters.LZW_MAX_OUTPUT_LENGTH = 1024 * 1024
    filters.RUN_LENGTH_MAX_OUTPUT_LENGTH = filters.MAX_ARRAY_BASED_STREAM_OUTPUT_LENGTH = 1024 * 1024
    options = json.loads(sys.argv[1])
    data = sys.stdin.buffer.read(8 * 1024 * 1024 + 1)
    if len(data) > 8 * 1024 * 1024:
        raise ValueError('PDF input size exceeded')
    reader = PdfReader(io.BytesIO(data), strict=True)
    if reader.is_encrypted:
        raise ValueError('Encrypted PDFs are unsupported; no password is requested')
    count = len(reader.pages)
    if not 1 <= count <= 50:
        raise ValueError('PDF must have 1..50 pages')
    from jan_mcp_commander.privacy import assert_public_text
    # Inspect all extracted text before returning a preview or copying pages.
    checked_text=[]
    text_size=0
    for page in reader.pages:
        content=page.get_contents()
        if content is not None and len(content.get_data())>1024*1024:
            raise ValueError('PDF content stream exceeds limit')
        page_text=page.extract_text() or ''
        text_size+=len(page_text.encode('utf-8'))
        if text_size>1024*1024:raise ValueError('PDF text exceeds privacy inspection limit')
        checked_text.append(page_text)
    assert_public_text('\n'.join(checked_text))
    pages = options['pages']
    if pages is None:
        text = ''
        for page in reader.pages:
            stream = page.get_contents()
            if stream is not None and len(stream.get_data()) > 1024 * 1024:
                raise ValueError('PDF content stream exceeds limit')
            text += (page.extract_text() or '') + '\n'
            if len(text.encode('utf-8')) >= 16384:
                break
        encoded = text.encode('utf-8')
        return {'page_count': count, 'text': encoded[:16384].decode('utf-8', 'ignore'), 'truncated': len(encoded) > 16384,
                'ocr_performed': False}
    if any(p > count for p in pages):
        raise ValueError('Requested PDF page does not exist')
    writer = PdfWriter()
    for number in pages:
        page = writer.add_page(reader.pages[number - 1], excluded_keys=['/Annots', '/AA', '/Metadata'])
        page.rotate(options['rotation'])
    out = io.BytesIO()
    writer.write(out)
    if out.tell() > 8 * 1024 * 1024:
        raise ValueError('PDF output size exceeded')
    return {'page_count': len(pages), 'data': base64.b64encode(out.getvalue()).decode('ascii')}


if __name__ == '__main__':
    try:
        result = main()
    except (ValueError, KeyError, IndexError):
        result = {'error': 'Unsupported, encrypted, malformed or oversized PDF; no output saved'}
    except Exception:
        result = {'error': 'PDF parser unavailable or resource limit reached; no output saved'}
    print(json.dumps(result, ensure_ascii=True))
