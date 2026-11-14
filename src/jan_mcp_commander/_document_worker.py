"""Isolated document worker: bytes on stdin, bounded bytes/receipts on stdout."""
import base64
import csv
import io
import json
import sys


def watch_parent(seconds=12,parent_pid=None):
    import os
    import threading
    import time
    from jan_mcp_commander.foreground import ParentSession
    parent=ParentSession(parent_pid);deadline=time.monotonic()+seconds
    if os.name=='posix':
        import signal
        signal.signal(signal.SIGALRM,signal.SIG_DFL)
        signal.setitimer(signal.ITIMER_REAL,seconds)
    def watch():
        while parent.alive() and time.monotonic()<deadline:time.sleep(.25)
        os._exit(124)
    threading.Thread(target=watch,name='pcrc-document-deadline',daemon=True).start()


def transform(job, assets):
    from jan_mcp_commander.document_formats import docx_model, edit_docx, docx_markdown, table_csv
    from jan_mcp_commander.document_pdf import markdown_pdf, page_operations, pdf_tables, open_pdf, render_pdf
    kind=job['kind']; data=assets.get(job.get('path'))
    outputs=[]
    if kind in {'verify_saved','inspect_pdf'}:
        path=job['path']
        if path.casefold().endswith('.docx'): review={'paragraph_count':docx_model(data)['paragraph_count'],'reopened':True}
        elif path.casefold().endswith('.pdf'):
            reader,texts=open_pdf(data)
            rendered,images=render_pdf(data,job.get('pages',[]))
            review={'page_count':len(reader.pages),'text':'\n'.join(texts)[:16000],'text_truncated':len('\n'.join(texts))>16000,
                'reopened':True,'rendering_verified':True,'rendered_pages':rendered}
            if kind=='inspect_pdf':return {'review':review,'outputs':[],'images':images}
        else:
            rows=list(csv.reader(io.StringIO(data.decode('utf-8-sig'))));review={'rows':len(rows),'reopened':True}
        return {'review':review,'outputs':[]}
    if kind in {'edit_docx','fill_docx_template','revise_docx_pdf'}:
        result,review=edit_docx(data,edits=job.get('edits'),values=job.get('values'))
        outputs.append((job['destination'],result))
        if kind=='revise_docx_pdf':
            pdf,pdf_review=markdown_pdf(docx_markdown(result),{})
            outputs.append((job['pdf_destination'],pdf));review['pdf']=pdf_review
    elif kind=='export_docx_pdf':
        result,review=markdown_pdf(docx_markdown(data),{});outputs.append((job['destination'],result))
        review['export_scope']='Semantic body headings, paragraphs and tables; not native Word pagination'
    elif kind=='create_markdown_pdf':
        result,review=markdown_pdf(job.get('markdown'),assets);outputs.append((job['destination'],result))
    elif kind=='pdf_pages':
        result,review=page_operations(assets,job.get('pages'));outputs.append((job['destination'],result))
    elif kind=='extract_tables':
        tables=docx_model(data)['tables'] if job['path'].casefold().endswith('.docx') else pdf_tables(data)
        result,review=table_csv(tables);outputs.append((job['destination'],result))
        review['method']='Word table XML' if job['path'].casefold().endswith('.docx') else 'Positioned text columns; review heuristic table boundaries'
    else: raise ValueError('Unsupported document transformation')
    return {'review':review,'outputs':[{'path':path,'data':base64.b64encode(data).decode()} for path,data in outputs]}


if __name__=='__main__':
    try:
        from jan_mcp_commander.worker_limits import apply_limits
        job_limit=apply_limits(512,cpu_seconds=12)
        watch_parent(parent_pid=int(sys.argv[1]))
        payload=sys.stdin.buffer.read(32*1024*1024+1)
        if len(payload)>32*1024*1024: raise ValueError('Combined document input limit exceeded')
        request=json.loads(payload)
        assets={path:base64.b64decode(data,validate=True) for path,data in request['assets'].items()}
        result=transform(request['job'],assets)
    except (ValueError,KeyError,IndexError) as error: result={'error':str(error)[:240]}
    except Exception: result={'error':'Malformed, unsupported or oversized document; no output saved'}
    print(json.dumps(result,ensure_ascii=True))
