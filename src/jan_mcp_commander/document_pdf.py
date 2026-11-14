"""Small bounded Markdown/PDF layout and page operations. No HTML, URLs or code."""
import io
import base64
import hashlib
import math
import re
import textwrap
from contextlib import closing

from pypdf import PdfReader, PdfWriter
from pypdf.generic import DictionaryObject, NameObject, NumberObject, DecodedStreamObject, EncodedStreamObject

from .privacy import assert_public_text

MAX_PDF = 8*1024*1024


def render_pdf(data, preview_pages=()):
    """Render decoded bytes in the process-limited worker; never initialize JS/forms."""
    import pypdfium2 as pdfium
    if not isinstance(preview_pages,(tuple,list)) or len(preview_pages)>2 or any(type(p) is not int or p<1 for p in preview_pages):
        raise ValueError('Preview at most two one-based PDF pages')
    frames=[];checks=[];pixels=0
    with pdfium.PdfDocument(data) as document:
        if not 1<=len(document)<=50 or any(p>len(document) for p in preview_pages):raise ValueError('PDF render page bounds exceeded')
        for index in range(len(document)):
            with closing(document[index]) as page:
                width,height=page.get_size()
                if not all(math.isfinite(v) and 0<v<=14400 for v in (width,height)):
                    raise ValueError('PDF render dimensions exceed limit')
                scale=min(1,1000/max(width,height));pixels+=math.ceil(width*scale)*math.ceil(height*scale)
                if pixels>32_000_000:raise ValueError('PDF total rendering limit exceeded')
                with closing(page.render(scale=scale,may_draw_forms=False,draw_annots=False,limit_image_cache=True)) as bitmap:
                    image=bitmap.to_pil().convert('RGB')
                    checks.append({'page':index+1,'width':image.width,'height':image.height,'pixel_sha256':hashlib.sha256(image.tobytes()).hexdigest()})
                    if index+1 in preview_pages:
                        out=io.BytesIO();image.save(out,format='JPEG',quality=65)
                        if out.tell()>500000:raise ValueError('PDF preview image exceeds limit')
                        frames.append({'mimeType':'image/jpeg','data':base64.b64encode(out.getvalue()).decode()})
                    image.close()
    return checks,frames


def open_pdf(data):
    import pypdf.filters as filters
    filters.ZLIB_MAX_OUTPUT_LENGTH = filters.LZW_MAX_OUTPUT_LENGTH = 1024*1024
    filters.RUN_LENGTH_MAX_OUTPUT_LENGTH = filters.MAX_ARRAY_BASED_STREAM_OUTPUT_LENGTH = 1024*1024
    if not data.startswith(b'%PDF-') or len(data) > MAX_PDF: raise ValueError('Invalid or oversized PDF')
    reader = PdfReader(io.BytesIO(data), strict=True)
    if reader.is_encrypted or not 1 <= len(reader.pages) <= 50:
        raise ValueError('Use an unencrypted PDF with 1..50 pages')
    root = reader.trailer['/Root']
    if any(key in root for key in ('/OpenAction','/AA','/AcroForm','/Names')):
        raise ValueError('Active, embedded-file or interactive PDFs are unsupported')
    texts = []
    for page in reader.pages:
        content = page.get_contents()
        if content is not None and len(content.get_data()) > 1024*1024:
            raise ValueError('PDF stream exceeds limit')
        text = page.extract_text() or ''
        if len(text.encode()) > 64000 or sum(len(t) for t in texts)+len(text) > 128000:
            raise ValueError('PDF text limit exceeded')
        texts.append(text)
    assert_public_text('\n'.join(texts))
    return reader, texts


def pdf_bytes(writer):
    out = io.BytesIO(); writer.write(out)
    if out.tell() > MAX_PDF: raise ValueError('PDF output exceeds 8 MiB')
    data = out.getvalue(); open_pdf(data)
    return data


def markdown_images(markdown):
    if not isinstance(markdown, str) or not markdown.strip() or len(markdown) > 16000:
        raise ValueError('Markdown must have 1..16000 characters')
    assert_public_text(markdown)
    if '<' in markdown or '\x00' in markdown:
        raise ValueError('HTML and control bytes are unsupported in Markdown')
    images = re.findall(r'!\[[^\]\n]{0,200}\]\(([^)\n]+)\)', markdown)
    if any(re.search(r'!\[[^\]]*\]\(',line) and not re.fullmatch(r'\s*!\[[^\]]*\]\([^)]+\)\s*',line)
           for line in markdown.splitlines() if not line.startswith('\\![')):
        raise ValueError('Put each Markdown image on a standalone line')
    if len(images) > 8: raise ValueError('At most eight workspace images')
    for path in images:
        if not path.casefold().endswith(('.png','.jpg','.jpeg')) or '://' in path:
            raise ValueError('Only approved workspace PNG/JPEG images are supported')
    return images


def markdown_pdf(markdown, images):
    markdown_images(markdown)
    writer = PdfWriter(); streams = []; y = 744; page = None; page_number = 0
    fonts = DictionaryObject()
    for key, font in [('F1','Courier'),('F2','Courier-Bold')]:
        fonts[NameObject('/'+key)] = DictionaryObject({NameObject('/Type'):NameObject('/Font'),
            NameObject('/Subtype'):NameObject('/Type1'),NameObject('/BaseFont'):NameObject('/'+font),NameObject('/Encoding'):NameObject('/WinAnsiEncoding')})
    def new_page():
        nonlocal page,y,streams,page_number
        if page is not None:
            stream = DecodedStreamObject();stream.set_data(('\n'.join(streams)).encode('ascii'));page.replace_contents(stream)
        if page_number >= 20: raise ValueError('Formatted PDF exceeds 20 pages')
        page = writer.add_blank_page(612,792); y = 744; streams = [];page_number += 1
        page[NameObject('/Resources')] = DictionaryObject({NameObject('/Font'):fonts,NameObject('/XObject'):DictionaryObject()})
    def room(height):
        if height > 696: raise ValueError('Block is too tall for a PDF page')
        if y-height < 48: new_page()
    def text(value,x,baseline,size=11,bold=False):
        try: encoded = value.encode('cp1252').hex()
        except UnicodeEncodeError as exc: raise ValueError('PDF font supports Windows-1252 text only; unsupported characters are rejected') from exc
        streams.append(f'BT /F{2 if bold else 1} {size} Tf 1 0 0 1 {x:.2f} {baseline:.2f} Tm <{encoded}> Tj ET')
    new_page(); lines = markdown.splitlines(); index = 0; expected = []
    while index < len(lines):
        line = lines[index].strip(); index += 1
        if not line: y -= 7; continue
        match = re.fullmatch(r'!\[([^\]]*)\]\(([^)]+)\)', line)
        if match:
            from PIL import Image
            source = images.get(match[2])
            if source is None or len(source) > 4*1024*1024: raise ValueError('Missing or oversized workspace image')
            with Image.open(io.BytesIO(source)) as image:
                if image.format not in {'PNG','JPEG'} or image.width*image.height > 4_000_000 or getattr(image,'n_frames',1)!=1:
                    raise ValueError('Image type, animation or pixel limit denied')
                image.load(); rgb = image.convert('RGB'); out = io.BytesIO();rgb.save(out,format='JPEG',quality=85)
                width,height = rgb.size
            scale = min(516/width, 320/height, 1); dw,dh = width*scale,height*scale;room(dh+12)
            obj = EncodedStreamObject();obj._data=out.getvalue()
            obj.update({NameObject('/Type'):NameObject('/XObject'),NameObject('/Subtype'):NameObject('/Image'),
                NameObject('/Width'):NumberObject(width),NameObject('/Height'):NumberObject(height),
                NameObject('/ColorSpace'):NameObject('/DeviceRGB'),NameObject('/BitsPerComponent'):NumberObject(8),NameObject('/Filter'):NameObject('/DCTDecode')})
            name = '/Im'+str(len(page['/Resources']['/XObject'])+1)
            page['/Resources']['/XObject'][NameObject(name)] = writer._add_object(obj)
            streams.append(f'q {dw:.2f} 0 0 {dh:.2f} 48 {y-dh:.2f} cm {name} Do Q'); y -= dh+12
            continue
        if line.startswith('|'):
            rows = []
            while True:
                if not re.fullmatch(r'[| :\-]+',line):
                    row = re.split(r'(?<!\\)\|',line.strip('|'))
                    rows.append([cell.replace('\\|','|').strip() for cell in row])
                if index >= len(lines) or not lines[index].strip().startswith('|'): break
                line=lines[index].strip();index+=1
            columns = len(rows[0]) if rows else 0
            if not 1 <= columns <= 8 or len(rows) > 100 or any(len(row)!=columns for row in rows):
                raise ValueError('Use a rectangular Markdown table: at most 8 columns and 100 rows')
            cell_width=516/columns
            for row_index,row in enumerate(rows):
                wrapped=[textwrap.wrap(value,width=max(1,int((cell_width-12)/6))) or [''] for value in row]
                height=max(map(len,wrapped))*14+10;room(height)
                for column,segments in enumerate(wrapped):
                    x=48+column*cell_width
                    streams.append(f'{x:.2f} {y-height:.2f} {cell_width:.2f} {height:.2f} re S')
                    for n,value in enumerate(segments):text(value,x+6,y-14-n*14,10,row_index==0);expected.append(value)
                y-=height
            y-=8;continue
        literal=line.startswith(('\\#','\\|','\\!['))
        heading = None if literal else re.match(r'^(#{1,6})\s+(.*)',line)
        size=22-2*(len(heading[1])-1) if heading else 11
        value=heading[2] if heading else line[1:] if literal else line
        indent=14 if re.match(r'^([-*+] |[0-9]+[.)] )',value) else 0
        for segment in textwrap.wrap(value,width=max(1,int((516-indent)/(0.6*size))),replace_whitespace=False) or ['']:
            room(size+8);text(segment,48+indent,y-size,size,bool(heading));y-=size+5;expected.append(segment)
        y-=4
    stream=DecodedStreamObject();stream.set_data(('\n'.join(streams)).encode('ascii'));page.replace_contents(stream)
    data=pdf_bytes(writer);_,texts=open_pdf(data)
    joined=' '.join(' '.join(texts).split())
    if any(' '.join(item.split()) not in joined for item in expected if item.strip()):
        raise ValueError('Generated PDF text did not reopen correctly')
    rendered,_=render_pdf(data)
    return data, {'page_count':page_number,'text_verified':True,'rendering_verified':True,'rendered_pages':rendered,
        'font':'Courier / Windows-1252','markdown':markdown,'images':list(images)}


def page_operations(sources, pages):
    if not isinstance(pages,list) or not 1 <= len(pages) <= 50:
        raise ValueError('Choose an exact output sequence of 1..50 source pages')
    readers={name:open_pdf(data) for name,data in sources.items()}
    writer=PdfWriter();expected=[]
    for item in pages:
        if not isinstance(item,dict) or set(item)!={'path','page'} or item['path'] not in readers or type(item['page']) is not int:
            raise ValueError('Each output page needs a reviewed source path and one-based page')
        reader,texts=readers[item['path']];number=item['page']
        if not 1 <= number <= len(reader.pages): raise ValueError('Requested PDF page does not exist')
        writer.add_page(reader.pages[number-1],excluded_keys=['/Annots','/AA','/Metadata'])
        expected.append(texts[number-1])
    data=pdf_bytes(writer);_,actual=open_pdf(data)
    if actual!=expected: raise ValueError('PDF page-order reopen verification failed')
    rendered,_=render_pdf(data)
    return data,{'page_count':len(pages),'pages':pages,'text_verified':True,'rendering_verified':True,'rendered_pages':rendered,'annotations_copied':False}


def pdf_tables(data):
    reader,texts=open_pdf(data)
    no_text=[index+1 for index,text in enumerate(texts) if not text.strip()]
    if no_text: raise ValueError('OCR_REQUIRED: pages '+','.join(map(str,no_text))+' have no extractable text; no incomplete table export was saved')
    tables=[]
    for index,page in enumerate(reader.pages,1):
        layout=page.extract_text(extraction_mode='layout')
        lines=[line for line in layout.splitlines() if line.strip()]
        rows=[re.split(r'\s{2,}|\t+',line.strip()) for line in lines]
        rows=[row for row in rows if len(row)>1]
        if rows:
            if len(rows)>100 or any(len(row)>20 for row in rows):raise ValueError('PDF table limits exceeded')
            tables.append({'location':'page'+str(index),'rows':rows,'needs_review':True,'ignored_non_table_lines':len(lines)-len(rows)})
    return tables
