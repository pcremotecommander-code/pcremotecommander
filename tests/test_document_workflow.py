"""Synthetic acceptance of reviewed document tools; never opens user documents."""
import hashlib
import io
import time
import threading
from zipfile import ZipFile, ZIP_DEFLATED

import pytest

from jan_mcp_commander.control import ControlCommander, CONTROL_METHODS, READ_TOOLS


def docx(text='Hello ', tail='world', extra=''):
    content = ('<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">'
        '<w:body><w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr>'
        '<w:r><w:rPr><w:b/></w:rPr><w:t xml:space="preserve">'+text+'</w:t></w:r>'
        '<w:r><w:rPr><w:i/></w:rPr><w:t>'+tail+'</w:t></w:r></w:p>'
        '<w:p><w:r><w:rPr><w:color w:val="123456"/></w:rPr><w:t>Keep this paragraph</w:t></w:r></w:p>'
        '<w:tbl><w:tr><w:tc><w:p><w:r><w:t>Item</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>Count</w:t></w:r></w:p></w:tc></w:tr>'
        '<w:tr><w:tc><w:p><w:r><w:t>Apples</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>12</w:t></w:r></w:p></w:tc></w:tr></w:tbl>'
        +extra+'</w:body></w:document>')
    out=io.BytesIO()
    with ZipFile(out,'w',ZIP_DEFLATED) as z:
        z.writestr('[Content_Types].xml','<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>')
        z.writestr('word/document.xml',content)
        z.writestr('word/styles.xml','<styles/>')
    return out.getvalue()


def sha(data):return hashlib.sha256(data).hexdigest()


@pytest.fixture
def commander(tmp_path,monkeypatch):
    monkeypatch.setenv('JAN_MCP_STATE_DIR',str(tmp_path/'state'))
    root=tmp_path/'files';root.mkdir()
    # Parser tests use a deterministic scan; real antivirus is tested independently.
    monkeypatch.setattr('jan_mcp_commander.security_scan.scan_bytes',lambda *a,**k:{'result':'synthetic_no_detection'})
    cmd=ControlCommander(root,enabled={'files'})
    yield cmd
    cmd.close_control()


def wait_plan(commander,plan):
    deadline=time.monotonic()+130
    while plan.get('status') in {'preparing','applying'} and not plan.get('outcome_unknown'):
        assert time.monotonic()<deadline,plan
        time.sleep(.5);plan=commander.get_document_workflow(plan['plan_id'])
    return plan


def review_jobs(commander,jobs):
    return wait_plan(commander,commander.preview_document_workflow(jobs))


def apply_review(commander,*args):
    return wait_plan(commander,commander.apply_document_workflow(*args))


def test_workflow_is_exposed_at_control_boundary():
    assert hasattr(ControlCommander,'preview_document_workflow'), 'Missing working document preview tool'
    assert CONTROL_METHODS.get('jan_apply_document_workflow')=='apply_document_workflow'
    assert 'jan_preview_document_workflow' in READ_TOOLS


def test_background_preparation_application_and_restart_receipts(commander,monkeypatch):
    from jan_mcp_commander import document_workflow as module
    data=docx();(commander.workspace/'source.docx').write_bytes(data)
    entered=threading.Event();release=threading.Event();actual=module.worker
    def blocked(*args,**kwargs):
        entered.set();assert release.wait(10);return actual(*args,**kwargs)
    monkeypatch.setattr(module,'worker',blocked)
    plan=commander.preview_document_workflow([editing(data)])
    assert entered.wait(3);assert plan['status']=='preparing' and not plan['outcome_unknown']
    assert not (commander.workspace/'revised.docx').exists()
    release.set();plan=wait_plan(commander,plan)
    release.clear();entered.clear()
    result=commander.apply_document_workflow(plan['plan_id'],plan['review_sha256'],plan['jobs'])
    assert entered.wait(3);assert result['status']=='applying' and not result['outcome_unknown']
    restarted=module.DocumentWorkflow(commander)
    assert restarted.get(plan['plan_id'])['outcome_unknown']
    with pytest.raises(ValueError,match='replay'):restarted.apply(plan['plan_id'],plan['review_sha256'],plan['jobs'])
    release.set();assert wait_plan(commander,result)['status']=='completed'


def test_split_runs_review_apply_and_reopen(commander):
    data=docx();(commander.workspace/'source.docx').write_bytes(data)
    preview=review_jobs(commander,[{'kind':'edit_docx','path':'source.docx','expected_sha256':sha(data),
        'destination':'revised.docx','edits':[{'location':'p00001','old':'Hello world','new':'Reviewed document'}]}])
    assert preview['jobs'][0]['status']=='ready'
    assert preview['jobs'][0]['review']['changes'][0]['before']=='Hello world'
    assert not (commander.workspace/'revised.docx').exists()
    result=apply_review(commander,preview['plan_id'],preview['review_sha256'],preview['jobs'])
    assert result['status']=='completed'
    assert result['jobs'][0]['outputs'][0]['verified']
    saved=(commander.workspace/'revised.docx').read_bytes()
    assert (commander.workspace/'source.docx').read_bytes()==data
    with ZipFile(io.BytesIO(saved)) as z,ZipFile(io.BytesIO(data)) as old:
        assert z.read('word/styles.xml')==old.read('word/styles.xml')
        xml=z.read('word/document.xml')
        assert b'<w:b/>' in xml and b'<w:i/>' in xml and b'123456' in xml
        assert b'Keep this paragraph' in xml
    with pytest.raises(ValueError,match='replay|already|completed'):
        apply_review(commander,preview['plan_id'],preview['review_sha256'],preview['jobs'])


def test_capacity_rejection_does_not_consume_reviews_or_approved_plan(commander):
    data=docx();(commander.workspace/'source.docx').write_bytes(data)
    plan=review_jobs(commander,[editing(data)])
    workflow=commander._documents()
    workflow.running={str(index):threading.Event() for index in range(4)}
    for _ in range(2):
        with pytest.raises(ValueError,match='capacity'):commander.preview_document_workflow([editing(data,'other.docx')])
    assert list(workflow.load())==[plan['plan_id']]
    with pytest.raises(ValueError,match='capacity'):
        commander.apply_document_workflow(plan['plan_id'],plan['review_sha256'],plan['jobs'])
    assert workflow.get(plan['plan_id'])['status']=='previewed'
    assert not (commander.workspace/'revised.docx').exists()
    workflow.running.clear()
    assert apply_review(commander,plan['plan_id'],plan['review_sha256'],plan['jobs'])['status']=='completed'


def test_document_cli_waits_for_review_and_verified_application(commander,capsys):
    import json
    from jan_mcp_commander.document_workflow import main
    data=docx();(commander.workspace/'source.docx').write_bytes(data)
    (commander.workspace/'jobs.json').write_text(json.dumps([editing(data)]))
    assert main(['preview','jobs.json'],str(commander.workspace))==0
    review=json.loads(capsys.readouterr().out)
    assert review['status']=='previewed'
    assert not (commander.workspace/'revised.docx').exists()
    assert main(['apply',review['plan_id'],'--review-sha256',review['review_sha256'],'--allow-writes'],str(commander.workspace))==0
    receipt=json.loads(capsys.readouterr().out)
    assert receipt['status']=='completed' and receipt['jobs'][0]['outputs'][0]['verified']


def editing(data, destination='revised.docx', **options):
    return {'kind':'edit_docx','path':'source.docx','expected_sha256':sha(data),'destination':destination,
        'edits':[{'location':'p00001','old':'Hello world','new':'Reviewed document'}],**options}


def test_stale_source_image_destination_and_ambiguous_text_are_rejected(commander):
    data=docx();path=commander.workspace/'source.docx';path.write_bytes(data)
    preview=review_jobs(commander,[editing(data)])
    path.write_bytes(docx('Different ', 'text'))
    result=apply_review(commander,preview['plan_id'],preview['review_sha256'],preview['jobs'])
    assert result['jobs'][0]['status']=='failed' and not (commander.workspace/'revised.docx').exists()
    data=docx('Hello world ', 'Hello world');path.write_bytes(data)
    result=review_jobs(commander,[editing(data)])
    assert 'ambiguous' in result['jobs'][0]['error']
    assert result['jobs'][0]['status']=='failed'
    path.write_bytes(docx())
    result=review_jobs(commander,[editing(docx(),expected_sha256='0'*64)])
    assert 'Source changed' in result['jobs'][0]['error']


def test_template_split_run_values_and_missing_or_duplicate_are_checked(commander):
    data=docx('{{cli','ent}}');(commander.workspace/'source.docx').write_bytes(data)
    job={'kind':'fill_docx_template','path':'source.docx','expected_sha256':sha(data),'destination':'filled.docx','values':{'client':'Sample Company'}}
    preview=review_jobs(commander,[job])
    assert preview['jobs'][0]['review']['changes'][0]['after']=='Sample Company'
    assert apply_review(commander,preview['plan_id'],preview['review_sha256'],preview['jobs'])['status']=='completed'
    from jan_mcp_commander.document_formats import docx_model
    assert docx_model((commander.workspace/'filled.docx').read_bytes())['locations'][0]['text']=='Sample Company'
    bad={**job,'destination':'missing.docx','values':{'other':'sample'}}
    assert review_jobs(commander,[bad])['jobs'][0]['status']=='failed'
    from jan_mcp_commander.document_formats import edit_docx
    with pytest.raises(ValueError,match='ambiguous'):
        edit_docx(docx('{{client}} ','{{client}}'),values={'client':'Sample'})


@pytest.mark.parametrize('data',[
    b'not a zip',
    b'PKbroken',
    docx(extra='<!DOCTYPE x>'),
])
def test_malformed_word_rejected(data):
    from jan_mcp_commander.document_formats import docx_model
    with pytest.raises(Exception):docx_model(data)


def test_oversized_macro_embedded_and_external_word_are_rejected():
    from jan_mcp_commander.document_formats import docx_model
    from jan_mcp_commander.office_documents import package
    with pytest.raises(ValueError):package(b'PK'+b'x'*(8*1024*1024))
    for name,content in [('word/embeddings/object.bin',b'object'),('word/vbaProject.bin',b'macro'),
        ('word/_rels/document.xml.rels',b'<Relationships><Relationship Target="https://invalid.example" TargetMode="External"/></Relationships>'),
        ('large.xml',b'x'*(4*1024*1024+1))]:
        out=io.BytesIO()
        with ZipFile(io.BytesIO(docx())) as original,ZipFile(out,'w',ZIP_DEFLATED) as target:
            for item in original.infolist():target.writestr(item,original.read(item))
            target.writestr(name,content)
        with pytest.raises(ValueError):docx_model(out.getvalue())


def test_stable_paragraph_heading_table_locations_and_unrelated_formatting():
    from jan_mcp_commander.document_formats import docx_model,edit_docx
    data=docx();model=docx_model(data)
    assert model['locations'][0]['location']=='p00001' and model['locations'][0]['style']=='Heading1'
    assert model['tables'][0]=={'location':'t00001','rows':[['Item','Count'],['Apples','12']]}
    result,_=edit_docx(data,[{'location':'p00001','old':'lo wor','new':'XX'}])
    assert docx_model(result)['locations'][0]['text']=='HelXXld'
    with ZipFile(io.BytesIO(result)) as z:
        xml=z.read('word/document.xml');assert b'<w:b/>' in xml and b'<w:i/>' in xml
    assert docx_model(result)['locations'][1:]==model['locations'][1:]


def test_cdata_text_is_not_lost_and_overlapping_matches_are_ambiguous():
    from jan_mcp_commander.document_formats import docx_model,edit_docx
    out=io.BytesIO()
    with ZipFile(io.BytesIO(docx())) as source,ZipFile(out,'w',ZIP_DEFLATED) as target:
        for item in source.infolist():
            data=source.read(item)
            if item.filename=='word/document.xml':data=data.replace(b'Hello </w:t>',b'Hello <![CDATA[hidden suffix]]><!--keep--></w:t>')
            target.writestr(item,data)
    data=out.getvalue()
    assert docx_model(data)['locations'][0]['text']=='Hello hidden suffixworld'
    result,_=edit_docx(data,[{'location':'p00001','old':'Hello ','new':'Reviewed '}])
    assert docx_model(result)['locations'][0]['text']=='Reviewed hidden suffixworld'
    with ZipFile(io.BytesIO(result)) as z:assert b'<!--keep-->' in z.read('word/document.xml')
    with pytest.raises(ValueError,match='ambiguous'):
        edit_docx(docx('aa','a'),[{'location':'p00001','old':'aa','new':'X'}])


def test_pdf_inspection_returns_rendered_visuals(commander):
    from jan_mcp_commander.pdf_tools import create_text_pdf
    data,_=create_text_pdf('Synthetic rendered PDF')
    (commander.workspace/'preview.pdf').write_bytes(data)
    result=commander.inspect_document_pdf('preview.pdf',[1])
    assert result['rendering_verified'] and result['page_count']==1 and result['sha256']==sha(data)
    assert len(result['images'])==1 and result['images'][0]['mimeType']=='image/jpeg'
    with pytest.raises(ValueError):commander.inspect_document_pdf('preview.pdf',[1,1,1])


def test_task_scope_checked_before_source_read(commander,monkeypatch):
    from jan_mcp_commander.coordination import coordinator,assignment
    data=docx();(commander.workspace/'source.docx').write_bytes(data)
    tasks=coordinator(commander);task=tasks.task('create',title='Synthetic scoped test')
    claim=tasks.task('claim',task_id=task['id'],agent='test',resources=['file:other.docx'])
    reads=[];actual=commander._tree.read
    def spy(path,*args,**kwargs):reads.append(path);return actual(path,*args,**kwargs)
    monkeypatch.setattr(commander._tree,'read',spy)
    context=assignment.set((task['id'],claim['lease_token']))
    try:
        result=review_jobs(commander,[editing(data)])
        assert result['jobs'][0]['status']=='failed'
        assert 'source.docx' not in reads
    finally:assignment.reset(context)


def test_review_covers_image_and_destination_changes(commander):
    from PIL import Image
    Image.new('RGB',(20,20),'blue').save(commander.workspace/'image.png')
    job={'kind':'create_markdown_pdf','destination':'image.pdf','markdown':'# Synthetic\n\n![image](image.png)'}
    p=review_jobs(commander,[job])
    Image.new('RGB',(20,20),'red').save(commander.workspace/'image.png')
    result=apply_review(commander,p['plan_id'],p['review_sha256'],p['jobs'])
    assert result['jobs'][0]['status']=='failed' and not (commander.workspace/'image.pdf').exists()
    data=docx();(commander.workspace/'source.docx').write_bytes(data)
    p=review_jobs(commander,[editing(data)])
    with pytest.raises(ValueError,match='review'):
        apply_review(commander,p['plan_id'],p['review_sha256'],[])
    (commander.workspace/'revised.docx').write_bytes(docx('Other ','file'))
    result=apply_review(commander,p['plan_id'],p['review_sha256'],p['jobs'])
    assert result['jobs'][0]['status']=='unknown' and not result['jobs'][0]['automatic_retry']


def test_complex_tables_and_inline_images_fail_explicitly():
    from jan_mcp_commander.document_formats import docx_model,table_csv,docx_markdown
    from jan_mcp_commander.document_pdf import markdown_pdf
    out=io.BytesIO()
    with ZipFile(io.BytesIO(docx())) as source,ZipFile(out,'w',ZIP_DEFLATED) as target:
        for item in source.infolist():
            data=source.read(item)
            if item.filename=='word/document.xml':data=data.replace(b'<w:tc>',b'<w:tc><w:tcPr><w:gridSpan w:val="2"/></w:tcPr>',1)
            target.writestr(item,data)
    model=docx_model(out.getvalue());assert model['tables'][0]['supported'] is False
    with pytest.raises(ValueError,match='merged'):table_csv(model['tables'])
    with pytest.raises(ValueError,match='merged'):docx_markdown(out.getvalue())
    with pytest.raises(ValueError,match='standalone'):markdown_pdf('Paragraph ![image](image.png) tail',{})


def test_csv_formula_cells_are_escaped():
    from jan_mcp_commander.document_formats import table_csv
    data,review=table_csv([{'rows':[['Label','Value'],['Cell','=1+1'],['Cell','@sum(1,2)']]}])
    assert review['formula_cells_escaped']==2
    assert "'=1+1" in data.decode('utf-8-sig')


def test_word_zip_expansion_count_and_pdf_page_limits():
    from jan_mcp_commander.document_formats import docx_model
    from jan_mcp_commander.document_pdf import open_pdf,page_operations
    out=io.BytesIO()
    with ZipFile(out,'w',ZIP_DEFLATED) as z:
        for index in range(257):z.writestr(f'part{index}.xml','<a/>')
    with pytest.raises(ValueError,match='extraction'):docx_model(out.getvalue())
    from pypdf import PdfWriter
    writer=PdfWriter()
    for _ in range(51):writer.add_blank_page(200,200)
    out=io.BytesIO();writer.write(out)
    with pytest.raises(ValueError,match='50'):open_pdf(out.getvalue())
    with pytest.raises(ValueError,match='1..50'):page_operations({},[])


def test_formatted_pdf_images_tables_lists_and_revised_export(commander):
    from PIL import Image
    from jan_mcp_commander.document_pdf import open_pdf
    Image.new('RGB',(30,20),'blue').save(commander.workspace/'image.png')
    markdown='# Monthly summary\n\nParagraph text.\n\n- First item\n- Second item\n\n| Item | Count |\n| --- | --- |\n| Apples | 12 |\n\n![Synthetic](image.png)'
    p=review_jobs(commander,[{'kind':'create_markdown_pdf','markdown':markdown,'destination':'report.pdf'}])
    assert p['jobs'][0]['status']=='ready',p
    assert p['jobs'][0]['review']['rendering_verified']
    result=apply_review(commander,p['plan_id'],p['review_sha256'],p['jobs'])
    assert result['status']=='completed',result
    reader,texts=open_pdf((commander.workspace/'report.pdf').read_bytes())
    assert len(reader.pages)==1 and len(reader.pages[0].images)==1
    assert all(t in texts[0] for t in ['Monthly summary','First item','Apples','12'])
    data=docx();(commander.workspace/'source.docx').write_bytes(data)
    job={**editing(data),'kind':'revise_docx_pdf','pdf_destination':'revised.pdf'}
    p=review_jobs(commander,[job]);result=apply_review(commander,p['plan_id'],p['review_sha256'],p['jobs'])
    assert result['status']=='completed' and len(result['jobs'][0]['outputs'])==2,result
    assert 'Reviewed document' in open_pdf((commander.workspace/'revised.pdf').read_bytes())[1][0]


def test_pdf_insert_delete_and_reorder_exact_sequence(commander):
    from jan_mcp_commander.pdf_tools import create_text_pdf
    from jan_mcp_commander.document_pdf import open_pdf
    from pypdf import PdfWriter,PdfReader
    writer=PdfWriter()
    for marker in ['FIRST','SECOND','THIRD']:
        data,_=create_text_pdf(marker);writer.add_page(PdfReader(io.BytesIO(data)).pages[0])
    out=io.BytesIO();writer.write(out);data=out.getvalue();(commander.workspace/'pages.pdf').write_bytes(data)
    extra,_=create_text_pdf('INSERTED');(commander.workspace/'insert.pdf').write_bytes(extra)
    sequence=[{'path':'pages.pdf','page':3},{'path':'insert.pdf','page':1},{'path':'pages.pdf','page':1}]
    p=review_jobs(commander,[{'kind':'pdf_pages','sources':[{'path':'pages.pdf','sha256':sha(data)},{'path':'insert.pdf','sha256':sha(extra)}],
        'pages':sequence,'destination':'arranged.pdf'}])
    assert p['jobs'][0]['review']['pages']==sequence
    assert apply_review(commander,p['plan_id'],p['review_sha256'],p['jobs'])['status']=='completed'
    reader,texts=open_pdf((commander.workspace/'arranged.pdf').read_bytes())
    assert len(reader.pages)==3 and [x.strip() for x in texts]==['THIRD','INSERTED','FIRST']


def test_table_extraction_csv_and_scanned_pdf_ocr_signal(commander):
    from jan_mcp_commander.document_pdf import markdown_pdf
    data=docx();(commander.workspace/'source.docx').write_bytes(data)
    pdf,_=markdown_pdf('| Item | Count |\n| --- | --- |\n| Apples | 12 |',{})
    (commander.workspace/'table.pdf').write_bytes(pdf)
    jobs=[{'kind':'extract_tables','path':path,'expected_sha256':sha(blob),'destination':dest}
          for path,blob,dest in [('source.docx',data,'word.csv'),('table.pdf',pdf,'pdf.csv')]]
    p=review_jobs(commander,jobs)
    assert all(j['status']=='ready' for j in p['jobs']),p
    assert apply_review(commander,p['plan_id'],p['review_sha256'],p['jobs'])['status']=='completed'
    for path in ['word.csv','pdf.csv']:
        text=(commander.workspace/path).read_text(encoding='utf-8-sig');assert 'Apples,12' in text
    from pypdf import PdfWriter
    writer=PdfWriter();writer.add_blank_page(200,200);out=io.BytesIO();writer.write(out)
    (commander.workspace/'scanned.pdf').write_bytes(out.getvalue())
    p=review_jobs(commander,[{'kind':'extract_tables','path':'scanned.pdf','expected_sha256':sha(out.getvalue()),'destination':'ocr.csv'}])
    assert p['jobs'][0]['status']=='failed' and 'OCR_REQUIRED' in p['jobs'][0]['error']
    assert not (commander.workspace/'ocr.csv').exists()


@pytest.mark.parametrize('failure',[RuntimeError,OSError,ValueError])
def test_partial_batch_and_uncertain_write_are_not_replayed(commander,monkeypatch,failure):
    data=docx();(commander.workspace/'source.docx').write_bytes(data)
    p=review_jobs(commander,[editing(data),editing(data,'bad.docx',expected_sha256='0'*64)])
    r=apply_review(commander,p['plan_id'],p['review_sha256'],p['jobs'])
    assert r['status']=='partial_failure' and [j['status'] for j in r['jobs']]==['completed','failed']
    p=review_jobs(commander,[editing(data,'uncertain.docx')])
    actual=commander._write_binary
    def interrupted(*args,**kwargs):
        actual(*args,**kwargs);raise failure('Synthetic interrupted receipt')
    monkeypatch.setattr(commander,'_write_binary',interrupted)
    r=apply_review(commander,p['plan_id'],p['review_sha256'],p['jobs'])
    assert r['jobs'][0]['status']=='unknown' and not r['jobs'][0]['automatic_retry']
    assert r['jobs'][0]['outputs'][0]['path']=='uncertain.docx'
    assert (commander.workspace/'uncertain.docx').exists()
    with pytest.raises(ValueError,match='replay'):apply_review(commander,p['plan_id'],p['review_sha256'],p['jobs'])


def test_overwrite_backup_and_review_hash_binding(commander):
    data=docx();(commander.workspace/'source.docx').write_bytes(data)
    old=docx('Older ','copy');(commander.workspace/'revised.docx').write_bytes(old)
    p=review_jobs(commander,[editing(data,overwrite=True,expected_destination_sha256=sha(old))])
    with pytest.raises(ValueError,match='Review hash'):apply_review(commander,p['plan_id'],'0'*64,p['jobs'])
    r=apply_review(commander,p['plan_id'],p['review_sha256'],p['jobs']);assert r['status']=='completed'
    backup=r['jobs'][0]['outputs'][0]['backup_id'];assert backup
    commander.restore_backup(backup);assert (commander.workspace/'revised.docx').read_bytes()==old


def test_capability_scope_reservations_privacy_and_size_limits(commander):
    data=docx();(commander.workspace/'source.docx').write_bytes(data)
    with pytest.raises(ValueError):review_jobs(commander,[editing(data,'../outside.docx')])
    commander.allow_writes=False
    p=review_jobs(commander,[editing(data)])
    with pytest.raises(ValueError):apply_review(commander,p['plan_id'],p['review_sha256'],p['jobs'])
    commander.enabled=frozenset({'commands'})
    with pytest.raises(ValueError):review_jobs(commander,[editing(data)])
    from jan_mcp_commander.document_pdf import markdown_pdf
    with pytest.raises(ValueError):markdown_pdf('# '+'x'*16000,{})
    with pytest.raises(ValueError):markdown_pdf('![remote](https://invalid.example/image.png)',{})
    from jan_mcp_commander.document_formats import edit_docx
    with pytest.raises(ValueError):edit_docx(docx('{{pass','word}}'),values={'password':'synthetic-value'})

def test_receipt_polling_does_not_reserve_workspace(commander):
    from jan_mcp_commander.coordination import coordinator

    data=docx();(commander.workspace/'source.docx').write_bytes(data)
    plan=review_jobs(commander,[editing(data)])
    assert plan['status']=='previewed'

    # A disjoint active workspace operation must not block a read-only receipt.
    store=coordinator(commander)
    with store.guard(['file:unrelated.txt']):
        receipt=commander.get_document_workflow(plan['plan_id'])
    assert receipt['status']=='previewed'

def test_expired_task_lease_during_document_apply_is_safe_prewrite_failure(commander,monkeypatch):
    from threading import Event
    from jan_mcp_commander import document_workflow as module
    from jan_mcp_commander.coordination import assignment,coordinator

    data=docx();(commander.workspace/'source.docx').write_bytes(data)
    store=coordinator(commander)
    task=store.task('create',title='File-scoped document task')
    lease=store.task('claim',task_id=task['id'],agent='document worker',
                     resources=['file:source.docx','file:revised.docx'])
    marker=assignment.set((lease['id'],lease['lease_token']))
    release=Event();entered=Event()
    actual=module.DocumentWorkflow.execute
    def blocked(self,plan):
        entered.set()
        assert release.wait(10)
        return actual(self,plan)
    monkeypatch.setattr(module.DocumentWorkflow,'execute',blocked)
    try:
        preview=review_jobs(commander,[editing(data)])
        assert preview['jobs'][0]['status']=='ready'
        applied=commander.apply_document_workflow(
            preview['plan_id'],preview['review_sha256'],preview['jobs'])
        assert entered.wait(5)
        with store.store.locked():
            state=store.load()
            state['tasks'][lease['id']]['expires_at']=store.clock()-1
            store.save(state)
    finally:
        assignment.reset(marker)
        release.set()

    receipt=wait_plan(commander,commander.get_document_workflow(applied['plan_id']))
    assert receipt['status']=='partial_failure'
    assert receipt['jobs'][0]['status']=='failed'
    assert not (commander.workspace/'revised.docx').exists()

def test_document_review_cannot_cross_task_lease_reassignment(commander):
    from jan_mcp_commander.coordination import CoordinationError, assignment, coordinator

    data=docx();(commander.workspace/'source.docx').write_bytes(data)
    store=coordinator(commander)
    task=store.task('create',title='Lease-bound document review')
    first=store.task('claim',task_id=task['id'],agent='first reviewer',
                     resources=['file:source.docx','file:revised.docx'])

    marker=assignment.set((first['id'],first['lease_token']))
    try:
        review=review_jobs(commander,[editing(data)])
    finally:
        assignment.reset(marker)

    # A clean handoff releases the first lease and permits a new claimant,
    # but the old review must not silently transfer to that new lease.
    store.task('finish',task_id=first['id'],lease_token=first['lease_token'],
               status='queued')
    second=store.task('claim',task_id=first['id'],agent='second reviewer',
                      resources=['file:source.docx','file:revised.docx'])
    assert second['revision'] > first['revision']

    marker=assignment.set((second['id'],second['lease_token']))
    try:
        with pytest.raises(CoordinationError,match='earlier task lease'):
            commander.get_document_workflow(review['plan_id'])
        with pytest.raises(CoordinationError,match='earlier task lease'):
            commander.apply_document_workflow(
                review['plan_id'],review['review_sha256'],review['jobs'])
    finally:
        assignment.reset(marker)
    assert not (commander.workspace/'revised.docx').exists()

def test_prewrite_writer_rejection_is_not_reported_as_unknown(commander,monkeypatch):
    from jan_mcp_commander.core import OperationNotAppliedFileExists

    data=docx();(commander.workspace/'source.docx').write_bytes(data)
    review=review_jobs(commander,[editing(data)])
    def rejected_before_write(*args,**kwargs):
        raise OperationNotAppliedFileExists('Destination appeared before write; no output was changed')
    monkeypatch.setattr(commander,'_write_binary',rejected_before_write)

    receipt=apply_review(commander,review['plan_id'],review['review_sha256'],review['jobs'])
    assert receipt['status']=='partial_failure'
    assert receipt['jobs'][0]['status']=='failed'
    assert receipt['jobs'][0]['outcome_unknown'] is False
    assert receipt['jobs'][0]['automatic_retry'] is False
    assert not (commander.workspace/'revised.docx').exists()
