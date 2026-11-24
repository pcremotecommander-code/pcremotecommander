import json
import os
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import threading
from concurrent.futures import ThreadPoolExecutor
from contextvars import copy_context
from threading import Event
import pytest
from jan_mcp_commander.control import ControlCommander
from jan_mcp_commander.coordination import CoordinationError, assignment, coordinator
from jan_mcp_commander.browser_teaching import read_workflows

HTML = b'''<!doctype html><a id="next" href="/next">Next</a><input id="name"><input id="private" type="password"><input id="card" autocomplete="section-payment CC-NUMBER"><button id="done" onclick="document.getElementById('result').textContent='Done';window.clicks=(window.clicks||0)+1">Finish</button><p id="result"></p>'''


@pytest.fixture
def demo(tmp_path, monkeypatch):
    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            self.send_response(200)
            self.send_header('Content-Type', 'text/html')
            self.end_headers()
            self.wfile.write(HTML)
        def log_message(self, *args):
            pass
    http = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
    thread = threading.Thread(target=http.serve_forever, daemon=True)
    thread.start()
    workspace = tmp_path / 'workspace'
    workspace.mkdir()
    monkeypatch.setenv('JAN_MCP_STATE_DIR', str(tmp_path / 'private'))
    pc = ControlCommander(workspace, enabled={'files', 'browser'}, headless=True,
                          browser_channel=os.environ.get('JAN_MCP_BROWSER_CHANNEL', 'msedge' if os.name == 'nt' else 'chromium'))
    pc.browser_action('open', f'http://127.0.0.1:{http.server_port}/')
    store = coordinator(pc)
    task = store.task('create', title='Synthetic teaching')
    lease = store.task('claim', task_id=task['id'], agent='human demonstration', resources=['ui'])
    marker = assignment.set((lease['id'], lease['lease_token']))
    try:
        yield pc
    finally:
        assignment.reset(marker)
        pc.close_control()
        http.shutdown()
        http.server_close()


def demonstrate(pc):
    pc.browser_workflow('teach_start', {'title': 'Synthetic form'})
    def human():
        page = pc._browser[3]
        page.locator('#name').fill('PRIVATE_INPUT_NEVER_RECORDED')
        page.locator('#private').fill('PASSWORD_NEVER_RECORDED')
        page.locator('#card').fill('4242424242424242')
        page.locator('#done').click()
    pc._browser_executor.submit(human).result()
    draft = pc.browser_workflow('teach_finish')
    assert 'PRIVATE_INPUT' not in json.dumps(draft)
    assert 'PASSWORD' not in json.dumps(draft)
    assert all(step.get('target') != '#private' for step in draft['steps'])
    assert all(step.get('target') != '#card' for step in draft['steps'])
    assert len(draft['steps']) == 3
    return draft


def test_api_click_on_a_unique_clean_link_without_id_is_teachable(demo):
    pc=demo
    pc._browser_executor.submit(lambda:pc._browser[3].evaluate("document.querySelector('#next').removeAttribute('id')")).result()
    pc.browser_workflow('teach_start',{'title':'Clean link without ID'})
    pc.browser_action('click','a[href="/next"]')
    draft=pc.browser_workflow('teach_finish')
    assert draft['status']=='draft'
    assert draft['steps'][1]['target']=='a[href="/next"]'
    assert draft['expected_url'].endswith('/next')


@pytest.mark.parametrize('markup',['<a href="/next?synthetic=blocked">Next</a>','<a href="/next">One</a><a href="/next">Two</a>','<a href="http://[">Malformed</a>'])
def test_teaching_rejects_unsafe_or_ambiguous_link_fallback(demo,markup):
    pc=demo
    pc._browser_executor.submit(lambda:pc._browser[3].evaluate('(html)=>document.body.innerHTML=html','<button id="valid">Valid</button>'+markup)).result()
    pc.browser_workflow('teach_start',{'title':'Unsupported link'})
    pc.browser_action('click','#valid')
    pc._browser_executor.submit(lambda:pc._browser[3].locator('a').first.click()).result()
    with pytest.raises(CoordinationError,match='complete supported'):
        pc.browser_workflow('teach_finish')
    assert pc._teaching is None
    assert read_workflows(pc,'list')['workflows']==[]


def test_real_browser_demonstration_review_parameterized_replay_and_verification(demo):
    pc = demo
    draft = demonstrate(pc)
    assert draft['status'] == 'draft'
    with pytest.raises(ValueError, match='credentials locally'):
        pc.browser_action('fill', '#card', 'synthetic blocked value')
    with pytest.raises(CoordinationError):
        pc.browser_workflow('start_run', {'workflow_id': draft['id']})
    pc.browser_workflow('publish', {'workflow_id': draft['id'], 'reviewed': True, 'expected_text': 'Done'})
    run = pc.browser_workflow('start_run', {'workflow_id': draft['id']})
    first = pc.browser_workflow('run_next', {'run_id': run['id'], 'expected_step': 0})
    assert first['next_step'] == 1
    with pytest.raises(CoordinationError, match='already advanced'):
        pc.browser_workflow('run_next', {'run_id': run['id'], 'expected_step': 0})
    pc.browser_workflow('run_next', {'run_id': run['id'], 'expected_step': 1, 'inputs': {'input_1': 'Fresh value'}})
    final = pc.browser_workflow('run_next', {'run_id': run['id'], 'expected_step': 2})
    assert final['status'] == 'passed'
    assert read_workflows(pc, 'run', run['id'])['status'] == 'passed'
    assert pc._browser_executor.submit(lambda: pc._browser[3].evaluate('window.clicks')).result() == 1
    with pytest.raises(CoordinationError):
        pc.browser_workflow('run_next', {'run_id': run['id'], 'expected_step': 2})
    pc.browser_workflow('publish', {'workflow_id': draft['id'], 'reviewed': True, 'expected_text': 'Missing success marker'})
    failing = pc.browser_workflow('start_run', {'workflow_id': draft['id']})
    for index in range(3):
        failed = pc.browser_workflow('run_next', {'run_id': failing['id'], 'expected_step': index, 'inputs': {'input_1': 'fresh'}})
    assert failed['status'] == 'failed'
    with pytest.raises(CoordinationError, match='prior run'):
        pc.browser_workflow('start_run', {'workflow_id': draft['id']})
    pc.browser_workflow('delete', {'workflow_id': draft['id']})
    assert read_workflows(pc, 'list')['workflows'] == []
    assert read_workflows(pc, 'run', run['id'])['status'] == 'passed'


def test_concurrent_duplicate_run_step_executes_browser_action_once(demo, monkeypatch):
    pc = demo
    draft = demonstrate(pc)
    pc.browser_workflow('publish', {'workflow_id': draft['id'], 'reviewed': True, 'expected_text': 'Done'})
    run = pc.browser_workflow('start_run', {'workflow_id': draft['id']})

    entered = Event()
    release = Event()
    calls = []
    original = pc._browser_action

    def blocked(action, target, text):
        calls.append((action, target))
        entered.set()
        assert release.wait(5)
        return original(action, target, text)

    monkeypatch.setattr(pc, '_browser_action', blocked)
    with ThreadPoolExecutor(max_workers=2) as pool:
        first_context = copy_context()
        second_context = copy_context()
        first = pool.submit(first_context.run, pc.browser_workflow, 'run_next', {'run_id': run['id'], 'expected_step': 0})
        if not entered.wait(5):
            first.result(timeout=1)
            pytest.fail('first workflow step did not reach the browser action')
        second = pool.submit(second_context.run, pc.browser_workflow, 'run_next', {'run_id': run['id'], 'expected_step': 0})
        release.set()
        assert first.result(timeout=10)['next_step'] == 1
        with pytest.raises(CoordinationError, match='already advanced'):
            second.result(timeout=10)

    assert len(calls) == 1
    assert read_workflows(pc, 'run', run['id'])['next_step'] == 1


def test_uncertain_step_never_replays_and_query_links_denied(demo, monkeypatch):
    pc = demo
    draft = demonstrate(pc)
    pc.browser_workflow('publish', {'workflow_id': draft['id'], 'reviewed': True, 'expected_text': 'Done'})
    run = pc.browser_workflow('start_run', {'workflow_id': draft['id']})
    calls = []
    def uncertain(*args):
        calls.append(args)
        raise TimeoutError('private browser diagnostic')
    monkeypatch.setattr(pc, '_browser_action', uncertain)
    with pytest.raises(CoordinationError, match='not be replayed'):
        pc.browser_workflow('run_next', {'run_id': run['id'], 'expected_step': 0})
    assert read_workflows(pc, 'run', run['id'])['status'] == 'unknown'
    with pytest.raises(CoordinationError, match='prior run'):
        pc.browser_workflow('start_run', {'workflow_id': draft['id']})
    with pytest.raises(CoordinationError):
        pc.browser_workflow('run_next', {'run_id': run['id'], 'expected_step': 0})
    assert len(calls) == 1


def test_navigation_keeps_the_before_click_url_and_query_pages_cannot_be_taught(demo):
    pc = demo
    pc.browser_workflow('teach_start', {'title': 'Navigate and fill'})
    def human():
        page = pc._browser[3]
        page.locator('#next').click()
        page.locator('#name').fill('never persisted')
        page.locator('#done').click()
    pc._browser_executor.submit(human).result()
    draft = pc.browser_workflow('teach_finish')
    assert not draft['steps'][1]['before_url'].endswith('/next')
    assert draft['steps'][2]['before_url'].endswith('/next')
    pc.browser_workflow('publish', {'workflow_id': draft['id'], 'reviewed': True, 'expected_text': 'Done'})
    run = pc.browser_workflow('start_run', {'workflow_id': draft['id']})
    for index in range(4):
        result = pc.browser_workflow('run_next', {'run_id': run['id'], 'expected_step': index, 'inputs': {'input_2': 'fresh'}})
    assert result['status'] == 'passed'
    pc.browser_action('open', draft['steps'][0]['target'] + '?private=value')
    with pytest.raises(CoordinationError, match='without query'):
        pc.browser_workflow('teach_start', {'title': 'Unsafe URL'})


def test_navigation_alone_explains_missing_demonstration(demo):
    pc=demo
    pc.browser_workflow('teach_start', {'title':'Navigation only'})
    pc.browser_action('open', pc._browser_executor.submit(lambda: pc._browser[3].url).result())
    with pytest.raises(CoordinationError, match='Navigation alone'):
        pc.browser_workflow('teach_finish')
    assert pc._teaching is None
    assert not read_workflows(pc, 'list')['workflows']

def test_expired_ready_run_requires_review_and_fresh_lease_before_resume(demo):
    import time
    pc=demo;store=coordinator(pc)
    draft=demonstrate(pc)
    pc.browser_workflow('publish',{'workflow_id':draft['id'],'reviewed':True,'expected_text':'Done'})
    run=pc.browser_workflow('start_run',{'workflow_id':draft['id']})
    assert run['lease']['renew_before_seconds']==60
    assert 'lease_token' not in run['lease']
    old=assignment.get();clock=store.clock
    store.clock=lambda:clock()+121
    try:
        with pytest.raises(CoordinationError):pc.browser_workflow('run_next',{'run_id':run['id'],'expected_step':0})
        assert read_workflows(pc,'run',run['id'])['next_step']==0
        store.task('reconcile',task_id=old[0],reviewed=True)
        fresh=store.task('claim',task_id=old[0],agent='reviewed synthetic resume',resources=['ui'])
        assert fresh['lease_token']!=old[1]
        marker=assignment.set((fresh['id'],fresh['lease_token']))
        try:
            for index in range(3):
                store.task('renew',task_id=fresh['id'],lease_token=fresh['lease_token'])
                result=pc.browser_workflow('run_next',{'run_id':run['id'],'expected_step':index,'inputs':{'input_1':'Fresh test'}})
            assert result['status']=='passed'
        finally:assignment.reset(marker)
    finally:store.clock=clock
