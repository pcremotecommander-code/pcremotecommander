import json
from pathlib import Path
import sys
import time
import pytest
from jan_mcp_commander.control import ControlCommander
from jan_mcp_commander.core import PermissionDenied
from jan_mcp_commander.development import Development, package_specs, probe
import jan_mcp_commander.development as dev

@pytest.fixture
def pc(tmp_path,monkeypatch):
    workspace=tmp_path/'workspace';workspace.mkdir()
    monkeypatch.setenv('JAN_MCP_STATE_DIR',str(tmp_path/'private'))
    value=ControlCommander(workspace,enabled={'files','commands'},duration_minutes=480)
    yield value
    value.close_control()

def wait(pc,value):
    deadline=time.monotonic()+60
    while value['status'] in {'preparing','applying'}:
        assert time.monotonic()<deadline
        time.sleep(1);value=pc.get_development_change(value['plan_id'])
    return value

@pytest.mark.parametrize('value',['--index-url=x','pkg @ https://bad.test/x','pkg; calc','-e .','pkg\nother','../file','pkg==1 --extra-index-url=x'])
def test_injection_denied(value):
    with pytest.raises(ValueError):package_specs([value])

def test_detect_bounded_dependencies_and_no_scripts(pc):
    pc._tree.write('requirements.txt',b'numpy==2.2.0\n# comment\n')
    result=pc.inspect_development('project.detect_dependencies',{})
    assert result['packages']==['numpy==2.2.0'] and not result['build_scripts_executed']
    pc._tree.write('requirements.txt',b'--index-url https://bad.test',overwrite=True)
    with pytest.raises(ValueError):pc.inspect_development('project.detect_dependencies',{})

def test_probe_valid_broken_and_internal(pc):
    assert probe(sys.executable)['valid']
    assert not probe(str(pc.workspace/'missing-python'))['valid']
    with pytest.raises(ValueError):dev.development_runtime(sys.executable)

def test_missing_venv_and_existing_directory(pc,monkeypatch):
    monkeypatch.setattr(dev,'development_runtime',lambda p:{'modules':{'venv':False,'ensurepip':False}})
    with pytest.raises(ValueError):pc.preview_development_change('environment.create',{'runtime':'synthetic'})
    pc._tree.mkdir('.venv')
    with pytest.raises(FileExistsError):pc.preview_development_change('environment.create',{'runtime':'synthetic'})

def test_scope_and_capabilities(pc):
    for name in ['../.venv','C:/outside/.venv','.env/.venv','.','different']:
        with pytest.raises(ValueError):pc.preview_development_change('environment.create',{'environment':name})
    pc.enabled=frozenset({'files'})
    with pytest.raises(PermissionDenied):pc.inspect_development('runtime.list',{})

def test_receipt_fences_restart_and_stale_hash(pc,monkeypatch):
    service=pc._development()
    monkeypatch.setattr(service,'launch',lambda *a:None)
    monkeypatch.setattr(service,'full_runtime',lambda p:{'executable':sys.executable,'modules':{'venv':True,'ensurepip':True}})
    result=service.preview('environment.create',{'runtime':'synthetic'})
    assert result['status']=='queued'
    with pytest.raises(ValueError):service.apply(result['plan_id'],'0'*64)

def test_real_managed_environment_create_inspect_remove(pc,monkeypatch):
    runtime=Path('C:/Python314/python.exe') if sys.platform=='win32' else Path('/usr/bin/python3')
    if not runtime.exists():pytest.skip('Full development Python unavailable')
    actual=probe(str(runtime))
    if not actual.get('modules',{}).get('ensurepip'):pytest.skip('Full Python ensurepip unavailable')
    monkeypatch.setattr(dev,'development_runtime',lambda p:actual)
    plan=wait(pc,pc.preview_development_change('environment.create',{'runtime':str(runtime)}))
    assert plan['status']=='previewed' and not (pc.workspace/'.venv').exists()
    with pytest.raises(ValueError):pc.apply_development_change(plan['plan_id'],'0'*64)
    result=wait(pc,pc.apply_development_change(plan['plan_id'],plan['review_sha256']))
    assert result['status']=='completed',result
    assert result['result']['verified']
    assert pc.inspect_development('package.check',{})['exit_code']==0
    assert pc.inspect_development('project.verify_environment',{'imports':['json']})['imports']['output']=={'json':True}
    with pytest.raises(ValueError):pc.apply_development_change(plan['plan_id'],plan['review_sha256'])
    import os
    if os.environ.get('PCRC_PYPI_ACCEPTANCE')=='1':
        pc._tree.write('.venv/pip.ini',b'[global]\nextra-index-url = http://127.0.0.1:1/forbidden\n[install]\ntarget = C:/forbidden-pcrc-test\n')
        package=wait(pc,pc.preview_development_change('package.install',{'packages':['six==1.17.0'],'imports':['six']}))
        assert package['status']=='previewed',package
        assert package['review']['resolved'][0]['sha256']
        installed=wait(pc,pc.apply_development_change(package['plan_id'],package['review_sha256']))
        assert installed['status']=='completed',{'receipt':installed,'logs':[pc.process_output(i)['output'] for i in installed['sessions']]}
        assert installed['result']['imports_verified']==['six']
        verify=pc._development().read_command([str(pc.workspace/'.venv'/'Scripts'/'python.exe'),'-I','-c','import six;print(six.__version__)'])
        assert verify['output'].strip()=='1.17.0'
        uninstall=wait(pc,pc.preview_development_change('package.uninstall',{'packages':['six']}))
        assert wait(pc,pc.apply_development_change(uninstall['plan_id'],uninstall['review_sha256']))['status']=='completed'
    removal=wait(pc,pc.preview_development_change('environment.remove',{}))
    removed=wait(pc,pc.apply_development_change(removal['plan_id'],removal['review_sha256']))
    assert removed['status']=='completed' and not (pc.workspace/'.venv').exists()
    assert (pc.workspace/removed['result']['recoverable_directory']).is_dir()

def test_two_clients_do_not_fence_a_live_worker(pc,monkeypatch):
    import threading
    service=pc._development();entered=threading.Event();release=threading.Event()
    monkeypatch.setattr(service,'full_runtime',lambda p:{'executable':sys.executable,'modules':{'venv':True,'ensurepip':True}})
    original=service.prepare
    def prepare(identifier):
        entered.set();assert release.wait(10);original(identifier)
    monkeypatch.setattr(service,'prepare',prepare)
    plan=service.preview('environment.create',{'runtime':'synthetic'})
    try:
        assert entered.wait(5)
        second=Development(pc)
        assert second.get(plan['plan_id'])['status']=='preparing'
    finally:release.set()
    assert wait(pc,plan)['status']=='previewed'

def test_bounded_output_and_missing_runtime(pc):
    with pytest.raises(ValueError):dev.bounded_process([sys.executable,'-I','-c',"print('x'*1000000)"],5,pc.workspace,1024)
    assert not probe(str(pc.workspace/'missing'/'python.exe'))['valid']

def test_marker_forgery_and_missing_uv_denied(pc,monkeypatch):
    pc._tree.mkdir('.venv')
    pc._tree.write('.venv/pcrc-environment.json',b'{"status":"ready","path":".venv"}')
    with pytest.raises(ValueError):pc.inspect_development('environment.inspect',{})
    monkeypatch.setattr(dev,'uv_executable',lambda:None)
    monkeypatch.setattr(dev,'uv_bootstrap',lambda:(_ for _ in ()).throw(ValueError('Synthetic platform unavailable')))
    with pytest.raises(ValueError):pc.preview_development_change('runtime.install',{'version':'3.12.12'})

def test_failed_preparation_offline_does_not_create_environment(pc,monkeypatch):
    service=pc._development()
    monkeypatch.setattr(service,'full_runtime',lambda p:{'executable':sys.executable,'modules':{'venv':True,'ensurepip':True}})
    def fail(*args):raise OSError('Synthetic offline')
    monkeypatch.setattr(service,'command',fail)
    plan=wait(pc,service.preview('project.setup_environment',{'runtime':'synthetic','packages':[]}))
    # A file-driven setup with no dependency file deliberately needs no network.
    assert plan['status']=='previewed'
    pc._tree.write('requirements.txt',b'synthetic-package==1.0\n')
    failed=wait(pc,service.preview('project.setup_environment',{'runtime':'synthetic'}))
    assert failed['status']=='failed' and not (pc.workspace/'.venv').exists()

def test_missing_pip_detected_and_no_ambient_pip_configuration(pc):
    code="from pip._internal.configuration import Configuration;import json;c=Configuration(isolated=True);c.load();print(json.dumps(dict(c.items())))"
    result=pc._development().read_command([sys.executable,'-I','-c',code])
    assert result['exit_code']==0 and result['output']=={}


def test_apply_expired_review_never_launches(pc,monkeypatch):
    service=pc._development()
    monkeypatch.setattr(service,'full_runtime',lambda p:{'executable':sys.executable,'modules':{'venv':True,'ensurepip':True}})
    plan=wait(pc,service.preview('environment.create',{'runtime':'synthetic'}))
    service.update(plan['plan_id'],expires_at=0)
    with pytest.raises(ValueError):service.apply(plan['plan_id'],plan['review_sha256'])
    assert not (pc.workspace/'.venv').exists()

@pytest.mark.parametrize('name',['../escape','/absolute','normal/../../escape','C:/escape','bad\\\\escape'])
def test_wheel_archive_path_denied(pc,name):
    import zipfile
    wheel=pc.workspace/'synthetic.whl'
    with zipfile.ZipFile(wheel,'w') as archive:archive.writestr(name,b'test')
    with pytest.raises(ValueError):dev.validate_wheel(wheel)

def test_wheel_directory_and_symlink_limits(pc):
    import zipfile,stat
    wheel=pc.workspace/'synthetic.whl'
    with zipfile.ZipFile(wheel,'w') as archive:
        entry=zipfile.ZipInfo('link');entry.external_attr=(stat.S_IFLNK|0o777)<<16
        archive.writestr(entry,'outside')
    with pytest.raises(ValueError):dev.validate_wheel(wheel)
    with zipfile.ZipFile(wheel,'w') as archive:
        for i in range(20001):archive.writestr(str(i),b'')
    with pytest.raises(ValueError):dev.validate_wheel(wheel)

def test_cancelled_creation_keeps_partial_environment_and_fences_replay(pc,monkeypatch):
    service=pc._development()
    monkeypatch.setattr(service,'full_runtime',lambda p:{'executable':sys.executable,'modules':{'venv':True,'ensurepip':True}})
    plan=wait(pc,service.preview('environment.create',{'runtime':'synthetic'}))
    command=service.command
    monkeypatch.setattr(service,'command',lambda identifier,argv:command(identifier,[sys.executable,'-I','-c','import time;time.sleep(30)']))
    result=service.apply(plan['plan_id'],plan['review_sha256'])
    deadline=time.monotonic()+10
    while not result['sessions']:
        assert time.monotonic()<deadline;time.sleep(.1);result=service.get(plan['plan_id'])
    pc.stop_session(result['sessions'][0])
    result=wait(pc,result)
    assert result['status']=='unknown' and result['automatic_retry'] is False
    assert service.marker('.venv')['status']=='creating'
    with pytest.raises(ValueError):service.apply(plan['plan_id'],plan['review_sha256'])
    removal=wait(pc,service.preview('environment.remove',{}))
    result=wait(pc,service.apply(removal['plan_id'],removal['review_sha256']))
    assert result['status']=='completed' and not (pc.workspace/'.venv').exists()

def test_two_environment_workers_are_serialized(pc,monkeypatch):
    import threading
    service=pc._development();entered=threading.Event();release=threading.Event();calls=[]
    for identifier in ['a'*32,'b'*32]:
        with service.store.locked():
            plans=service.load();plans[identifier]={'plan_id':identifier,'status':'queued','created_at':time.time(),'review':{'environment':'.venv'}};service.save(plans)
    def body(identifier):
        calls.append(identifier)
        if identifier=='a'*32:entered.set();assert release.wait(10)
    monkeypatch.setattr(service,'execute_locked',body)
    first=threading.Thread(target=service.execute,args=('a'*32,));second=threading.Thread(target=service.execute,args=('b'*32,))
    first.start();assert entered.wait(5);second.start();time.sleep(.2)
    assert calls==['a'*32]
    release.set();first.join(5);second.join(5)
    assert calls==['a'*32,'b'*32]

@pytest.mark.skipif(__import__('os').environ.get('PCRC_RUNTIME_INSTALL_ACCEPTANCE')!='1',reason='Explicit optional runtime download test')
def test_actual_pinned_uv_bootstrap_and_project_python(pc,monkeypatch):
    monkeypatch.setattr(dev,'uv_executable',lambda:None)
    plan=wait(pc,pc.preview_development_change('runtime.install',{'version':'3.12.12'}))
    assert plan['status']=='previewed' and plan['review']['uv_bootstrap']['sha256']
    assert not (pc.workspace/'.pcrc-python-3.12.12').exists()
    result=pc.apply_development_change(plan['plan_id'],plan['review_sha256'])
    deadline=time.monotonic()+240
    while result['status'] in {'preparing','applying','queued_for_apply'}:
        assert time.monotonic()<deadline
        time.sleep(2);result=pc.get_development_change(result['plan_id'])
    if result['status']!='completed':
        logs=[pc.process_output(i)['output'] for i in result['sessions']]
        pytest.fail(str(result)+' '+str(logs))
    assert result['result']['python']['version']=='3.12.12'
    runtime=result['result']['python']['executable']
    assert pc._development().full_runtime(runtime)['valid']
    env=wait(pc,pc.preview_development_change('environment.create',{'runtime':runtime,'imports':['json']}))
    assert wait(pc,pc.apply_development_change(env['plan_id'],env['review_sha256']))['status']=='completed'

def test_pip_guard_denies_outside_io_base_writes_network_and_builds(pc):
    import subprocess
    stage=pc.workspace/'stage';stage.mkdir()
    wrapper=Path(dev.__file__).with_name('_development_pip.py')
    code=r'''import os,sys,runpy,json
from pathlib import Path
import pip._internal.cli.main as pipmain
stage=Path(sys.argv[2]);outside=stage.parent/'outside'
def check():
    def denied(event,*args):
        try:sys.audit(event,*args)
        except PermissionError:return
        raise AssertionError('Unexpected allowed event '+event)
    sys.audit('open',str(stage/'ok'),'w',os.O_WRONLY)
    sys.audit('open',str(Path(sys.base_prefix)/'synthetic-read'),'r',os.O_RDONLY)
    denied('open',str(Path(sys.base_prefix)/'synthetic-write'),'w',os.O_WRONLY)
    denied('open',str(outside),'r',os.O_RDONLY)
    denied('os.rename',str(stage/'a'),str(outside),-1,-1)
    denied('os.mkdir',str(outside),0o700,-1)
    denied('os.listdir',None)
    denied('os.scandir',None)
    denied('socket.getaddrinfo','localhost',443,0,0,0)
    denied('socket.connect',None,('127.0.0.1',443))
    denied('subprocess.Popen','synthetic',[],None,None)
    sys.audit('socket.getaddrinfo','pypi.org',443,0,0,0)
    print('PCRC_PIP_GUARD_PASS');return 0
pipmain.main=lambda args:check()
sys.argv=[sys.argv[1],str(stage)]
runpy.run_path(sys.argv[0],run_name='__main__')
'''
    result=subprocess.run([sys.executable,'-I','-c',code,str(wrapper),str(stage)],capture_output=True,timeout=10)
    assert result.returncode==0,result.stderr.decode()
    assert b'PCRC_PIP_GUARD_PASS' in result.stdout

def test_malformed_project_metadata_does_not_become_character_packages(pc):
    pc._tree.write('pyproject.toml',b'[project]\ndependencies="numpy"\n')
    with pytest.raises(ValueError):pc.inspect_development('project.detect_dependencies',{})


def test_failed_owned_process_retains_private_safe_diagnostic(pc):
    service=pc._development();identifier='c'*32
    with service.store.locked():service.save({identifier:{'plan_id':identifier,'status':'preparing','review':{'environment':'.venv'},'sessions':[]}})
    with pytest.raises(ValueError):service.command(identifier,[sys.executable,'-I','-c',"print('SYNTHETIC_DOWNLOAD_FAILURE');raise SystemExit(7)"])
    plan=service.load()[identifier]
    assert plan['last_process_exit_code']==7 and 'SYNTHETIC_DOWNLOAD_FAILURE' in plan['last_process_error']
    service.cleanup(identifier)


def test_completed_receipts_evict_before_capacity_blocks_normal_work(pc,monkeypatch):
    service=pc._development()
    plans={format(i,'032x'):{'plan_id':format(i,'032x'),'created_at':time.time()-100+i,'status':'completed','review':{'action':'environment.create','environment':'.venv'}} for i in range(20)}
    with service.store.locked():service.save(plans)
    monkeypatch.setattr(service,'full_runtime',lambda p:{'executable':sys.executable,'modules':{'venv':True,'ensurepip':True}})
    plan=wait(pc,service.preview('environment.create',{'runtime':'synthetic'}))
    assert plan['status']=='previewed' and len(service.load())==20 and '0'*32 not in service.load()


def test_receipt_save_failure_stops_just_started_child(pc,monkeypatch):
    service=pc._development();identifier='d'*32;children=[]
    with service.store.locked():service.save({identifier:{'sessions':[]}})
    original=pc._start_controlled_argv
    def start(*args,**kwargs):
        result=original(*args,**kwargs)
        children.append(pc._sessions[result['session_id']]['process'])
        return result
    def fail_save(plans):raise OSError('Synthetic disk full')
    monkeypatch.setattr(pc,'_start_controlled_argv',start)
    monkeypatch.setattr(service,'save',fail_save)
    with pytest.raises(OSError,match='Synthetic disk full'):
        service.command(identifier,[sys.executable,'-I','-c','import time;time.sleep(30)'])
    assert len(children)==1 and children[0].poll() is not None
    service.cleanup(identifier)
