"""Reviewed, one-shot workspace document plans with durable partial receipts."""
import base64
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import time
import threading
import uuid
from contextvars import copy_context

from cryptography.hazmat.primitives.ciphers.aead import AESGCM

from .coordination import CoordinationError, assignment, coordinator, resource
from .environment import runtime_environment
from .privacy import assert_public_text
from .safe_fs import parts
from .security import PrivateStore
from .worker_limits import remaining

MAX_FILE = 8*1024*1024
KINDS = {'edit_docx','fill_docx_template','export_docx_pdf','revise_docx_pdf',
         'create_markdown_pdf','pdf_pages','extract_tables'}


class DocumentCapacityError(ValueError):
    """No worker was started, so the caller can safely restore its review."""


def digest(data): return hashlib.sha256(data).hexdigest()


def canonical(value): return json.dumps(value, sort_keys=True, ensure_ascii=True, separators=(',',':')).encode()


def validate_job(job):
    if not isinstance(job,dict) or not isinstance(job.get('kind'),str) or job['kind'] not in KINDS: raise ValueError('Choose a supported document workflow kind')
    allowed={'kind','destination','overwrite','expected_destination_sha256'}
    kind=job['kind']
    if kind=='create_markdown_pdf': allowed|={'markdown'}
    elif kind=='pdf_pages': allowed|={'sources','pages'}
    else: allowed|={'path','expected_sha256'}
    if kind in {'edit_docx','revise_docx_pdf'}: allowed|={'edits'}
    if kind=='fill_docx_template': allowed|={'values'}
    if kind=='revise_docx_pdf': allowed|={'pdf_destination'}
    if set(job)-allowed: raise ValueError('Unknown document workflow option')
    destination=job.get('destination');parts(destination)
    suffix='.docx' if kind in {'edit_docx','fill_docx_template','revise_docx_pdf'} else '.csv' if kind=='extract_tables' else '.pdf'
    if not destination.casefold().endswith(suffix): raise ValueError('Destination must be a '+suffix+' workspace file')
    if type(job.get('overwrite',False)) is not bool: raise ValueError('Overwrite must be boolean')
    if job.get('overwrite') and (not isinstance(job.get('expected_destination_sha256'),str) or not re.fullmatch('[a-f0-9]{64}',job['expected_destination_sha256'])):
        raise ValueError('Explicit overwrite requires a reviewed destination SHA-256')
    if kind=='revise_docx_pdf':
        parts(job.get('pdf_destination'))
        if not job['pdf_destination'].casefold().endswith('.pdf') or job.get('overwrite'):
            raise ValueError('Revised Word/PDF workflow requires two new output files')
    assert_public_text(canonical(job))
    return job


def worker(job, assets, deadline):
    payload=canonical({'job':job,'assets':{path:base64.b64encode(data).decode() for path,data in assets.items()}})
    if len(payload)>32*1024*1024: raise ValueError('Document inputs exceed combined limit')
    try:
        reply=subprocess.run([sys.executable,'-B','-I',str(Path(__file__).with_name('_document_worker.py')),str(os.getpid())],
            input=payload,stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,timeout=remaining(deadline,12),
            env=runtime_environment(),**({'creationflags':subprocess.CREATE_NO_WINDOW} if os.name=='nt' else {}))
    except subprocess.TimeoutExpired as exc: raise ValueError('Document processing timed out; inspect receipts before retrying') from exc
    if reply.returncode or len(reply.stdout)>24*1024*1024: raise ValueError('Document worker unavailable or resource limit exceeded')
    value=json.loads(reply.stdout)
    if value.get('error'): raise ValueError(value['error'])
    for output in value['outputs']:
        output['bytes']=base64.b64decode(output.pop('data'),validate=True)
        if len(output['bytes'])>MAX_FILE: raise ValueError('Document output exceeds 8 MiB')
    assert_public_text(canonical(value['review']))
    return value


def input_spec(job):
    from .document_pdf import markdown_images
    names=[]; expected={}
    if job['kind']=='create_markdown_pdf': names=markdown_images(job.get('markdown'))
    elif job['kind']=='pdf_pages':
        sources=job.get('sources')
        if not isinstance(sources,list) or not 1<=len(sources)<=5: raise ValueError('Choose 1..5 PDF sources')
        for source in sources:
            if not isinstance(source,dict) or set(source)!={'path','sha256'} or not isinstance(source['path'],str) or not source['path'].casefold().endswith('.pdf'):
                raise ValueError('Each PDF source needs path and SHA-256')
            if source['path'] in expected: raise ValueError('Duplicate PDF source')
            expected[source['path']]=source['sha256']
        names=list(expected)
    else:
        name=job.get('path');parts(name)
        permitted=('.docx','.pdf') if job['kind']=='extract_tables' else ('.docx',)
        if not name.casefold().endswith(permitted): raise ValueError('Unsupported document source type')
        names=[name];expected[name]=job.get('expected_sha256')
    for name in names:parts(name)
    return list(dict.fromkeys(names)),expected


def snapshot(commander, job, deadline):
    from .security_scan import scan_bytes
    names,expected=input_spec(job)
    assets={}
    for name in dict.fromkeys(names):
        parts(name)
        data=commander._tree.read(name,MAX_FILE)
        if name in expected and (not isinstance(expected[name],str) or not re.fullmatch('[a-f0-9]{64}',expected[name]) or digest(data)!=expected[name]):
            raise ValueError('Source changed; inspect it and preview a fresh plan')
        scan_bytes(data,Path(name).suffix,deadline=deadline);assets[name]=data
        if sum(map(len,assets.values()))>24*1024*1024: raise ValueError('Combined document inputs exceed 24 MiB')
    return assets


def outputs(job):
    return [job['destination']]+([job['pdf_destination']] if job['kind']=='revise_docx_pdf' else [])


class DocumentWorkflow:
    def __init__(self, commander):
        self.commander=commander
        self.store=PrivateStore(commander._store.path/'documents',commander.workspace)
        self.running={};self.run_lock=threading.Lock()

    def launch(self, plan_id, function, *args):
        from .advanced import MAX_SESSIONS
        with self.run_lock:
            self.running={key:event for key,event in self.running.items() if not event.is_set()}
            if len(self.running)>=MAX_SESSIONS:raise DocumentCapacityError('Document worker capacity reached; inspect active receipts before starting more work')
            done=threading.Event();self.running[plan_id]=done
        context=copy_context()
        def execute():
            def run_without_parent_reservation():
                # The scheduling API itself holds a workspace reservation.
                # Wait for that outer call to return before the background
                # worker tries to acquire its narrower source/output locks.
                coordination=coordinator(self.commander)
                with coordination.store.resource_locked('workspace'):
                    pass
                # Keep the claimed task identity, but do not inherit the
                # scheduling call's workspace reservation into this worker.
                # The worker must acquire and validate each exact file scope.
                marker=coordination.depth.set(None)
                try:
                    return function(*args)
                finally:
                    coordination.depth.reset(marker)
            try:context.run(run_without_parent_reservation)
            except Exception:
                # Applying failures stay unknown; preparation has made no document writes.
                try:
                    with self.store.locked():
                        plans=self.load();plan=plans.get(plan_id)
                        if plan and plan['status']=='preparing':
                            plan.update(status='preparation_failed',jobs=[{'status':'failed','error':'Preparation failed or exceeded review limits; use a smaller batch','outputs':[]}])
                            self.save(plans)
                except Exception:pass
            finally:done.set()
        try:threading.Thread(target=execute,name='pcrc-document-job',daemon=True).start()
        except Exception:
            done.set();raise

    def load(self):
        try: blob=self.store.tree.read('plans.enc',2*1024*1024)
        except FileNotFoundError: return {}
        return json.loads(AESGCM(self.store.key).decrypt(blob[:12],blob[12:],self.store.context))

    def save(self, plans):
        raw=canonical(plans)
        if len(raw)>1024*1024: raise ValueError('Document review capacity reached; use smaller batches')
        nonce=os.urandom(12)
        self.store.tree.write('plans.enc',nonce+AESGCM(self.store.key).encrypt(nonce,raw,self.store.context),overwrite=True)

    @staticmethod
    def public(plan):
        return {key:plan[key] for key in ('plan_id','review_sha256','status','expires_at','jobs')}

    def get(self, plan_id):
        if not isinstance(plan_id,str) or not re.fullmatch('[a-f0-9]{32}',plan_id): raise ValueError('Invalid document plan ID')
        with self.store.locked(): plan=self.load().get(plan_id)
        if not plan: raise ValueError('Document plan not found for this workspace')
        current=assignment.get()
        if current:
            if plan.get('task_id') != current[0]:
                raise CoordinationError('TASK_SCOPE_DENIED','Document review belongs to another task assignment.')
            tasks=coordinator(self.commander)
            with tasks.store.locked():
                data=tasks.load()
                tasks.expire(data)
                task=data['tasks'].get(current[0])
                if task is None:
                    raise CoordinationError('TASK_NOT_FOUND','Task not found; call list_tasks.')
                tasks.validate(task,current[1])
        value=self.public(plan)
        if value['status'] in {'preparing','applying'}:
            with self.run_lock:event=self.running.get(plan_id)
            active=event is not None and not event.is_set()
            if active:value.update(outcome_unknown=False,automatic_retry=False,instruction='Still running. Poll get_document_workflow; do not submit the action again.')
            elif value['status']=='preparing':value.update(status='preparation_interrupted',no_workspace_writes=True,automatic_retry=False,instruction='Preparation stopped without saving document outputs. Create a new review.')
            else:value.update(outcome_unknown=True,automatic_retry=False,instruction='Inspect output paths and receipts. Never replay this plan.')
        return value

    def preview(self, jobs):
        if not isinstance(jobs,list) or not 1<=len(jobs)<=5 or len(canonical(jobs))>30000:
            raise ValueError('Review 1..5 document jobs with at most 30000 bytes of options')
        destinations=set()
        # Reject duplicate/overlapping outputs across the combined review.
        for job in jobs:
            validate_job(job)
            for path in outputs(job):
                target=resource('file:'+path)
                if target in destinations: raise ValueError('Duplicate output paths in document batch')
                destinations.add(target)
        identifier=uuid.uuid4().hex
        current=assignment.get()
        plan={'plan_id':identifier,'task_id':current[0] if current else None,'status':'preparing','expires_at':time.time()+900,'jobs':[],'prepared':[],'review_sha256':''}
        with self.store.locked():
            plans=self.load()
            plans={k:v for k,v in plans.items() if v['status']=='applying' or v['expires_at']>time.time()}
            if len(plans)>=20: raise ValueError('Too many active document reviews; wait for expiry')
            plans[identifier]=plan;self.save(plans)
        try:self.launch(identifier,self.prepare,plan,jobs)
        except DocumentCapacityError:
            with self.store.locked():
                plans=self.load();plans.pop(identifier,None);self.save(plans)
            raise
        return self.get(identifier)

    def prepare(self, plan, jobs):
        deadline=time.monotonic()+120;records=[];prepared=[]
        for job in jobs:
            try:
                self.commander._require_capability('files')
                names,_=input_spec(job)
                with coordinator(self.commander).guard([resource('file:'+name) for name in [*names,*outputs(job)]]):
                    assets=snapshot(self.commander,job,deadline)
                    for path in outputs(job):
                        try: existing=self.commander._tree.read(path,MAX_FILE)
                        except FileNotFoundError: existing=None
                        if existing is not None and not job.get('overwrite'): raise ValueError('Output exists; choose a new file')
                        if job.get('overwrite') and (existing is None or digest(existing)!=job.get('expected_destination_sha256')):
                            raise ValueError('Destination changed; inspect it and preview again')
                    result=worker(job,assets,deadline)
                hashes={path:digest(data) for path,data in assets.items()}
                record={'status':'ready','kind':job['kind'],'sources':hashes,'review':result['review'],
                    'outputs':[{'path':o['path'],'sha256':digest(o['bytes']),'bytes':len(o['bytes'])} for o in result['outputs']]}
                records.append(record);prepared.append({'job':job,'sources':hashes})
            except (CoordinationError,ValueError,OSError) as exc:
                message=str(exc)[:240]
                try: assert_public_text(message)
                except ValueError: message='Private content was blocked'
                records.append({'status':'failed','kind':job['kind'],'error':message,'outputs':[]});prepared.append(None)
        if len(canonical(records))>64000: raise ValueError('Combined review is too large; use smaller documents or batches')
        plan.update(status='previewed',expires_at=time.time()+900,jobs=records,prepared=prepared)
        plan['review_sha256']=digest(canonical({'jobs':records,'prepared':prepared}))
        with self.store.locked():
            plans=self.load();plans[plan['plan_id']]=plan;self.save(plans)

    def apply(self, plan_id, review_sha256, review):
        self.get(plan_id)
        with self.store.locked():
            plans=self.load();plan=plans[plan_id]
            if plan['status']!='previewed': raise ValueError('Plan already used or outcome uncertain; never replay it')
            if plan['expires_at']<=time.time(): raise ValueError('Document review expired; preview again')
            if review_sha256!=plan['review_sha256']: raise ValueError('Review hash does not match; no files changed')
            if canonical(review)!=canonical(plan['jobs']): raise ValueError('Exact document review does not match; no files changed')
            plan['status']='applying';self.save(plans)
        try:self.launch(plan_id,self.execute,plan)
        except DocumentCapacityError:
            # Capacity rejection happens before any worker or write starts.
            with self.store.locked():
                plans=self.load();plans[plan_id]['status']='previewed';self.save(plans)
            raise
        return self.get(plan_id)

    def execute(self, plan):
        plan_id=plan['plan_id'];deadline=time.monotonic()+120
        for index,prepared in enumerate(plan['prepared']):
            record=plan['jobs'][index]
            if prepared is None: continue
            saved=[];attempted=None
            try:
                self.commander._require_binary_write()
                job=prepared['job']
                with coordinator(self.commander).guard([resource('file:'+name) for name in [*prepared['sources'],*outputs(job)]]):
                    assets=snapshot(self.commander,job,deadline)
                    if {path:digest(data) for path,data in assets.items()}!=prepared['sources']: raise ValueError('Source or image changed after review')
                    result=worker(job,assets,deadline)
                    proposed=[{'path':o['path'],'sha256':digest(o['bytes']),'bytes':len(o['bytes'])} for o in result['outputs']]
                    if proposed!=record['outputs'] or result['review']!=record['review']: raise ValueError('Prepared output differs from the reviewed plan')
                    record['status']='applying'
                    with self.store.locked(): plans=self.load();plans[plan_id]=plan;self.save(plans)
                    for output in result['outputs']:
                        path,data=output['path'],output['bytes']
                        attempted={'path':path,'verified':False,'outcome_unknown':True,'automatic_retry':False}
                        record['outputs']=[*saved,attempted]
                        with self.store.locked(): plans=self.load();plans[plan_id]=plan;self.save(plans)
                        write=self.commander._write_binary(path,data,overwrite=job.get('overwrite',False),
                            expected_sha256=job.get('expected_destination_sha256'),deadline=deadline)
                        saved.append({**write,'verified':False})
                        record['outputs']=saved
                        with self.store.locked(): plans=self.load();plans[plan_id]=plan;self.save(plans)
                        actual=self.commander._tree.read(path,MAX_FILE)
                        if digest(actual)!=digest(data): raise ValueError('Saved output hash verification failed')
                        # Worker reopens the saved bytes using the same bounded parser, not its in-memory object.
                        verification=worker({'kind':'verify_saved','path':path},{path:actual},deadline)
                        saved[-1].update(verified=True,verification=verification['review'])
                        attempted=None
                    record['status']='completed'
            except (ValueError,OSError) as exc:
                message=str(exc)[:240]
                try: assert_public_text(message)
                except ValueError: message='Private content was blocked'
                uncertain=attempted is not None
                receipts=[*saved,attempted] if uncertain and not any(o['path']==attempted['path'] for o in saved) else saved
                record.update(status='unknown' if uncertain else 'partial' if saved else 'failed',outputs=receipts,error=message,
                    outcome_unknown=uncertain,automatic_retry=False)
            except Exception:
                receipts=[*saved,attempted] if attempted and not any(o['path']==attempted['path'] for o in saved) else saved
                record.update(status='unknown',outputs=receipts,error='Outcome uncertain; inspect outputs, never replay',outcome_unknown=True,automatic_retry=False)
            with self.store.locked(): plans=self.load();plans[plan_id]=plan;self.save(plans)
        plan['status']='completed' if all(r['status']=='completed' for r in plan['jobs']) else 'partial_failure'
        with self.store.locked(): plans=self.load();plans[plan_id]=plan;self.save(plans)
        return self.public(plan)


def main(argv, workspace=None):
    import argparse
    from .cli import workspace_path
    from .control import ControlCommander
    parser=argparse.ArgumentParser(description='PCRC reviewed DOCX/PDF workflow; workspace JSON, no uncertain replay')
    actions=parser.add_subparsers(dest='action',required=True)
    preview=actions.add_parser('preview');preview.add_argument('jobs_file',help='Workspace JSON array of 1..5 document jobs')
    inspect=actions.add_parser('inspect');inspect.add_argument('path')
    receipt=actions.add_parser('receipt');receipt.add_argument('plan_id')
    apply=actions.add_parser('apply');apply.add_argument('plan_id');apply.add_argument('--review-sha256',required=True);apply.add_argument('--allow-writes',action='store_true')
    args=parser.parse_args(argv)
    commander=ControlCommander(workspace_path(workspace),enabled={'files'})
    commander.allow_writes=getattr(args,'allow_writes',False)
    try:
        if args.action=='preview': result=commander.preview_document_workflow(json.loads(commander._tree.read(args.jobs_file,30000)))
        elif args.action=='receipt': result=commander.get_document_workflow(args.plan_id)
        elif args.action=='inspect': result=commander.inspect_document_pdf(args.path) if args.path.casefold().endswith('.pdf') else commander.inspect_office(args.path)
        else:
            review=commander.get_document_workflow(args.plan_id)['jobs']
            result=commander.apply_document_workflow(args.plan_id,args.review_sha256,review)
        deadline=time.monotonic()+125
        while result.get('status') in {'preparing','applying'} and not result.get('outcome_unknown'):
            if time.monotonic()>=deadline:break
            time.sleep(.5);result=commander.get_document_workflow(result['plan_id'])
        result.pop('images',None)
        print(json.dumps(result,ensure_ascii=True))
        return 0 if result.get('status') not in {'partial_failure','applying','preparing','preparation_interrupted'} and not any(j.get('status')=='failed' for j in result.get('jobs',[])) else 1
    except (ValueError,OSError) as exc:
        from .errors import public_error
        print(json.dumps(public_error(exc)));return 1
    finally: commander.close_control()
