"""User-started recording in the isolated browser; drafts are never authorization."""
import copy
import time
import uuid
from urllib.parse import urlsplit
from .coordination import CoordinationError, assignment, coordinator

RECORDER = r'''() => {
 if(window.__pcrcRecorderInstalled)return;
 window.__pcrcRecorderInstalled=true;
 const selector=e=>{
  const unique=s=>document.querySelectorAll(s).length===1?s:null;
  if(e.id)return unique('#'+CSS.escape(e.id));
  for(const a of ['data-testid','aria-label','name'])if(e.getAttribute(a))
   return unique(e.tagName.toLowerCase()+'['+a+'='+JSON.stringify(e.getAttribute(a))+']');
  if(e.matches('a[href]')){
   const href=e.getAttribute('href');let url;
   try{url=new URL(href,location.href);}catch{return null;}
   if(['http:','https:'].includes(url.protocol)&&!url.username&&!url.password&&!url.search&&!url.hash)
    return unique('a[href='+JSON.stringify(href)+']');
  }
  return null;
 };
 const sensitive=e=>e.matches('input[type=password i],input[type=hidden i],input[type=file i],[autocomplete*="one-time-code" i],[autocomplete*="current-password" i],[autocomplete*="new-password" i],[autocomplete*="cc-" i]');
 const send=(event,action)=>{
  if(!window.__pcrcTeaching||!event.isTrusted||window!==window.top)return;
  const e=event.target.closest('a,button,input,textarea,select');
  if(!e||sensitive(e))return;
  if(action==='click'&&!e.matches('a,button,input[type=button],input[type=submit]'))return;
  const target=selector(e);
  window.__pcrcRecord({action:e.matches('select')?'select':e.matches('input[type=checkbox]')?'check':action,
   target:target||'',origin:location.origin,pathname:location.pathname,unsupported:!target});
 };
 document.addEventListener('click',e=>send(e,'click'),true);
 document.addEventListener('change',e=>send(e,'fill'),true);
}'''


def clean_url(url):
    parsed = urlsplit(url)
    if parsed.scheme not in {'http', 'https'} or not parsed.hostname or parsed.username or parsed.password or parsed.query or parsed.fragment:
        raise CoordinationError('WORKFLOW_URL_DENIED', 'Teach mode requires HTTP(S) pages without query strings, fragments or embedded credentials.')
    return parsed.geturl()


def owner(commander):
    current = assignment.get()
    if current is None:
        raise CoordinationError('TASK_LEASE_REQUIRED', 'Claim a task with the ui resource and supply its task_id and lease_token first.')
    return current[0]


def record_event(commander, source, event):
    recording = getattr(commander, '_teaching', None)
    if recording is None or source.get('page') is not recording['page'] or not isinstance(event, dict):
        return
    if time.monotonic() - recording['started'] > 120 or len(recording['steps']) >= 30:
        recording['unsupported'] += 1
        return
    action, target = event.get('action'), event.get('target')
    if action not in {'click', 'fill', 'check', 'select'} or not isinstance(target, str) or not 1 <= len(target) <= 512 or event.get('unsupported'):
        recording['unsupported'] += 1
        return
    try:
        clean_url(recording['page'].url)
        origin, pathname = event.get('origin'), event.get('pathname')
        if not isinstance(origin, str) or not isinstance(pathname, str) or len(origin) + len(pathname) > 2048:
            raise ValueError('Invalid observed location')
        url = clean_url(origin + pathname)
    except (CoordinationError, ValueError):
        recording['unsupported'] += 1
        return
    # The fixed recorder never sends values; ignore extra fields from untrusted page scripts.
    step = {'action': action, 'target': target, 'before_url': url}
    if action != 'click':
        step['input'] = 'input_' + str(len(recording['steps']))
    recording['steps'].append(step)


def workflow_action(commander, action, options):
    store = coordinator(commander)
    page = commander._browser[3] if commander._browser else None
    with store.guard(['ui']):
        task_id = owner(commander)
        data = store.load()
        lease= {'task_id':task_id,'expires_at':data['tasks'][task_id]['expires_at'],'renew_before_seconds':60,'instructions':'Call renew_task with the current lease token before each replay step and at least every 60 seconds while active. An expired assignment requires actual-state review and reconcile_task; never replay an uncertain step.'}
        if action == 'teach_start':
            if page is None or getattr(commander, '_teaching', None):
                raise CoordinationError('WORKFLOW_RECORDING_UNAVAILABLE', 'Open the isolated browser first and finish any existing recording.')
            url = clean_url(page.url)
            title = options.get('title', '')
            if not isinstance(title, str) or not 1 <= len(title) <= 160:
                raise ValueError('Workflow title must be 1..160 characters')
            if len(data['workflows']) >= 50:
                raise ValueError('Workflow limit reached')
            if not getattr(commander, '_recorder_binding', False):
                commander._browser[2].expose_binding('__pcrcRecord', lambda source, event: record_event(commander, source, event))
                commander._browser[2].add_init_script('(' + RECORDER + ')(); window.__pcrcTeaching=true;')
                commander._recorder_binding = True
            commander._teaching = {'task_id': task_id, 'title': title, 'page': page, 'started': time.monotonic(),
                                  'steps': [{'action': 'open', 'target': url}], 'unsupported': 0}
            page.evaluate(RECORDER)
            page.evaluate('window.__pcrcTeaching=true')
            return {'recording': True, 'max_seconds': 120, 'instructions': 'In this isolated browser, demonstrate at least one supported button click or input change using stable controls, then finish within two minutes. Navigation alone is not recorded as a complete demonstration. Input values are not recorded; replay needs fresh parameters. Credentials and file uploads are excluded.'}
        if action in {'teach_finish', 'teach_cancel'}:
            recording = getattr(commander, '_teaching', None)
            if recording is None or recording['task_id'] != task_id:
                raise CoordinationError('WORKFLOW_RECORDING_UNAVAILABLE', 'No recording belongs to this task.')
            recording['page'].evaluate('window.__pcrcTeaching=false')
            commander._teaching = None
            if action == 'teach_cancel':
                return {'recording': False, 'saved': False}
            if not recording['unsupported'] and len(recording['steps']) < 2:
                raise CoordinationError('WORKFLOW_RECORDING_INCOMPLETE', 'Navigation alone is not a complete demonstration. Start recording again, demonstrate a button click or input change on a stable control, then finish within two minutes. The incomplete recording was discarded; no draft was saved.')
            if recording['unsupported'] or len(recording['steps']) < 2:
                raise CoordinationError('WORKFLOW_RECORDING_INCOMPLETE', 'No complete supported demonstration was captured. Start again using stable browser controls within two minutes.')
            identifier = uuid.uuid4().hex
            workflow = {'id': identifier, 'title': recording['title'], 'steps': recording['steps'], 'status': 'draft',
                        'expected_url': clean_url(recording['page'].url), 'expected_text': '', 'version': 1}
            data['workflows'][identifier] = workflow
            store.save(data)
            return workflow
        workflow = data['workflows'].get(options.get('workflow_id'))
        if action == 'delete':
            if workflow is None:
                raise CoordinationError('WORKFLOW_NOT_FOUND', 'Workflow not found. Call list_workflows.')
            del data['workflows'][workflow['id']]
            store.save(data)
            return {'deleted': workflow['id'], 'run_history_retained': True}
        if action == 'publish':
            if workflow is None or options.get('reviewed') is not True:
                raise CoordinationError('WORKFLOW_REVIEW_REQUIRED', 'Inspect the draft and confirm its exact steps before publishing.')
            expected = options.get('expected_text', '')
            if not isinstance(expected, str) or not 1 <= len(expected) <= 200:
                raise ValueError('Supply 1..200 characters of expected visible completion text')
            workflow.update(status='published', expected_text=expected, version=workflow['version'] + int(workflow['status'] == 'published'))
            store.save(data)
            return workflow
        if action == 'start_run':
            if workflow is None or workflow['status'] != 'published' or getattr(commander, '_teaching', None):
                raise CoordinationError('WORKFLOW_REVIEW_REQUIRED', 'Publish the reviewed workflow and finish teaching before replay.')
            if any(run['workflow']['id'] == workflow['id'] and run['status'] in {'ready', 'unknown', 'failed'} for run in data['runs'].values()):
                raise CoordinationError('WORKFLOW_REVIEW_REQUIRED', 'A prior run is unfinished or failed verification. Inspect it; resume only a ready run, or reconcile its task after user review. Do not create a new run to bypass an unknown outcome.')
            if len(data['runs']) >= 100:
                finished = next((key for key, run in data['runs'].items() if run['status'] in {'passed', 'abandoned_after_review'}), None)
                if finished:
                    del data['runs'][finished]
                else:
                    raise ValueError('Workflow run limit reached; unresolved runs require local review')
            identifier = uuid.uuid4().hex
            run = {'id': identifier, 'task_id': task_id, 'workflow': copy.deepcopy(workflow), 'next_step': 0, 'status': 'ready'}
            data['runs'][identifier] = run
            store.save(data)
            return {'id': identifier, 'next_step': 0, 'lease':lease, 'inputs': [s['input'] for s in workflow['steps'] if 'input' in s]}
        if action != 'run_next':
            raise ValueError('Unknown browser workflow action')
        run = data['runs'].get(options.get('run_id'))
        if run is None or run['task_id'] != task_id or run['status'] != 'ready':
            raise CoordinationError('WORKFLOW_RUN_UNAVAILABLE', 'Run missing, completed or uncertain. Inspect its status; do not replay uncertain steps.')
        expected_step = options.get('expected_step')
        if type(expected_step) is not int or expected_step != run['next_step']:
            raise CoordinationError('WORKFLOW_STEP_CONFLICT', 'Step already advanced or its state changed. Inspect the run before requesting a new action.')
        step = run['workflow']['steps'][expected_step]
        text = ''
        if 'input' in step:
            text = options.get('inputs', {}).get(step['input'])
            if not isinstance(text, str) or len(text) > 4096:
                raise ValueError('Fresh input parameter required; values are never taken from the recording')
        if step['action'] != 'open' and (page is None or clean_url(page.url) != step['before_url']):
            raise CoordinationError('WORKFLOW_PAGE_CHANGED', 'Browser page differs from the demonstrated step. Inspect it; this step was not executed.')
        run['status'] = 'unknown'
        store.save(data)
        try:
            result = commander._browser_action(step['action'], step['target'], text)
            run['next_step'] += 1
            if run['next_step'] == len(run['workflow']['steps']):
                passed = not result.get('url_parameters_redacted') and result.get('url') == run['workflow']['expected_url'] and run['workflow']['expected_text'] in result.get('text', '')
                run['status'] = 'passed' if passed else 'failed'
            else:
                run['status'] = 'ready'
            store.save(data)
        except Exception:
            raise CoordinationError('WORKFLOW_OUTCOME_UNKNOWN', 'Step did not return a verified result. It will not be replayed; inspect the browser and run status.') from None
        return {'id': run['id'], 'next_step': run['next_step'], 'status': run['status'], 'lease':lease, 'url': result.get('url'),
                'verification': 'visible text and URL' if run['status'] in {'passed', 'failed'} else 'pending'}


def read_workflows(commander, kind, identifier=''):
    store = coordinator(commander)
    with store.store.locked():
        data = store.load()
        if kind == 'list':
            return {'workflows': [{k: w[k] for k in ['id', 'title', 'status', 'version']} for w in data['workflows'].values()],
                    'recent_runs': [{'id': r['id'], 'workflow_id': r['workflow']['id'], 'task_id': r['task_id'],
                                     'next_step': r['next_step'], 'status': r['status']} for r in list(data['runs'].values())[-20:]]}
        if kind == 'workflow':
            result = data['workflows'].get(identifier)
        elif kind == 'run':
            result = data['runs'].get(identifier)
            if result:
                result = {k: v for k, v in result.items() if k != 'workflow'}
        else:
            raise ValueError('Unknown workflow view')
        if result is None:
            raise CoordinationError('WORKFLOW_NOT_FOUND', 'Workflow or run not found. List workflows and use a returned ID.')
        return result
