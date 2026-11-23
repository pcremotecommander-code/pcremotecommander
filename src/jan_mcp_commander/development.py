"""Reviewed project Python environments; never install into PCRC's interpreter."""
from contextvars import copy_context
import hashlib
import hmac
import importlib.util
from itertools import islice
import json
import os
import shutil
import stat
import struct
import zipfile
from pathlib import Path
import re
import subprocess
import sys
import threading
import time
import tomllib
import uuid
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from .coordination import coordinator, assignment
from .environment import runtime_environment, command_path
from .privacy import assert_public_text
from .safe_fs import parts, check
from .security import PrivateStore

INDEX = 'https://pypi.org/simple'
PROBE = """import sys,platform,importlib.util,json,importlib.metadata as m
print(json.dumps({'executable':sys.executable,'version':platform.python_version(),'architecture':platform.machine(),'prefix':sys.prefix,'base_prefix':sys.base_prefix,'modules':{n:importlib.util.find_spec(n.split('.')[0]) is not None for n in ['pip','venv','ensurepip','tkinter','virtualenv']}}))"""
SPEC = re.compile(r'[A-Za-z0-9][A-Za-z0-9._-]*(?:\[[A-Za-z0-9_,.-]+\])?(?:\s*(?:==|!=|>=|<=|~=|>|<)[A-Za-z0-9][A-Za-z0-9.*+!_-]*(?:\s*,\s*(?:==|!=|>=|<=|~=|>|<)[A-Za-z0-9][A-Za-z0-9.*+!_-]*)*)?')


def canonical(value): return json.dumps(value, sort_keys=True, separators=(',', ':')).encode()
def sha(data): return hashlib.sha256(data).hexdigest()
def package_specs(values):
    if not isinstance(values,list) or len(values)>40 or any(not isinstance(v,str) or len(v)>180 or not SPEC.fullmatch(v) for v in values):
        raise ValueError('Use at most 40 ordinary package names/version specifications; URLs, options, markers and editable installs are denied')
    assert_public_text(canonical(values))
    return values


def runtime_candidates():
    candidates=[Path(sys.executable)]
    if os.name=='nt':
        import winreg
        for hive in [winreg.HKEY_CURRENT_USER,winreg.HKEY_LOCAL_MACHINE]:
            for view in [winreg.KEY_WOW64_64KEY,winreg.KEY_WOW64_32KEY]:
                try:
                    with winreg.OpenKey(hive,r'Software\Python\PythonCore',0,winreg.KEY_READ|view) as root:
                        for i in range(min(winreg.QueryInfoKey(root)[0],12)):
                            version=winreg.EnumKey(root,i)
                            try:
                                with winreg.OpenKey(root,version+r'\InstallPath') as entry:
                                    candidates.append(Path(winreg.QueryValue(entry,None))/'python.exe')
                            except OSError: pass
                except OSError: pass
        roots=[Path(os.environ.get('SystemDrive','C:')+'/'),Path(os.environ.get('LOCALAPPDATA',str(Path.home())))/'Programs'/'Python']
        for root in roots:
            candidates.extend(p/'python.exe' for p in islice(root.glob('Python3*'),12))
    else:
        candidates.extend(Path(p) for p in ['/usr/bin/python3','/usr/local/bin/python3','/opt/homebrew/bin/python3'])
    return list(dict.fromkeys(str(p.absolute()) for p in candidates))[:24]


def bounded_process(argv,timeout,cwd,limit=65536):
    from .portable import PortableCommander
    options={'creationflags':subprocess.CREATE_NEW_PROCESS_GROUP|subprocess.CREATE_NO_WINDOW} if os.name=='nt' else {'start_new_session':True}
    environment=runtime_environment();environment['PIP_CONFIG_FILE']=os.devnull
    proc=subprocess.Popen(argv,env=environment,cwd=cwd,stdin=subprocess.DEVNULL,stdout=subprocess.PIPE,stderr=subprocess.STDOUT,**options)
    output=bytearray();overflow=threading.Event()
    def read():
        while chunk:=proc.stdout.read(4096):
            if len(output)+len(chunk)>limit:
                overflow.set();PortableCommander._terminate(proc);break
            output.extend(chunk)
    reader=threading.Thread(target=read,daemon=True);reader.start()
    try:
        proc.wait(timeout=timeout);reader.join(timeout=2)
        if overflow.is_set() or reader.is_alive():raise ValueError('Runtime output limit exceeded')
        return proc.returncode,bytes(output)
    finally:
        PortableCommander._terminate(proc);reader.join(timeout=2);proc.stdout.close()


def probe(executable):
    try:
        code,output=bounded_process([executable,'-I','-c',PROBE],3,Path.home(),16384)
        if code:raise ValueError('Runtime probe failed')
        value=json.loads(output)
        value['valid']=True
        value['pcrc_internal']=Path(value['executable']).resolve()==Path(sys.executable).resolve() or 'PCRemoteCommander' in Path(value['executable']).parts
        return value
    except (OSError,ValueError,subprocess.TimeoutExpired):
        return {'executable':executable,'valid':False,'error':'Executable missing, broken, or probe timed out'}


def public_open(url,timeout):
    import urllib.request
    from urllib.parse import urlsplit
    parsed=urlsplit(url)
    if parsed.scheme!='https' or parsed.hostname not in {'pypi.org','files.pythonhosted.org'} or parsed.port not in {None,443} or parsed.username or parsed.password or parsed.query or parsed.fragment:raise ValueError('Development package source denied')
    class NoRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self,*args):raise ValueError('Development package redirect denied')
    return urllib.request.build_opener(NoRedirect).open(urllib.request.Request(url,headers={'User-Agent':'PCRemoteCommander/development'}),timeout=timeout)


def uv_bootstrap():
    import platform,urllib.request
    machine=platform.machine().lower()
    if machine not in {'amd64','x86_64','arm64','aarch64'}:raise ValueError('uv bootstrap supports x64/arm64 only; use an existing full Python on this architecture')
    if os.name=='nt':tag='win_arm64' if machine in {'arm64','aarch64'} else 'win_amd64'
    elif sys.platform=='darwin':tag='macosx_11_0_arm64' if machine in {'arm64','aarch64'} else 'macosx_10_12_x86_64'
    else:tag='aarch64' if machine in {'arm64','aarch64'} else 'x86_64'
    with public_open('https://pypi.org/pypi/uv/0.13.8/json',10) as response:raw=response.read(1024*1024+1)
    if len(raw)>1024*1024:raise ValueError('uv metadata too large')
    data=json.loads(raw)
    candidates=[f for f in data['urls'] if f['filename'].endswith(tag+'.whl') and (os.name=='nt' or sys.platform=='darwin' or ('musllinux' if platform.libc_ver()[0]=='musl' else 'manylinux') in f['filename'])]
    if not candidates:raise ValueError('No verified uv wheel for this platform; use an existing full Python or uv installation')
    item=candidates[0]
    from urllib.parse import urlsplit
    url=urlsplit(item['url']);digest=item['digests']['sha256']
    if url.scheme!='https' or url.hostname!='files.pythonhosted.org' or url.query or url.fragment or url.username or item['size']>32*1024*1024 or not re.fullmatch('[a-f0-9]{64}',digest):raise ValueError('Invalid uv bootstrap source')
    return {'version':'0.13.8','url':item['url'],'sha256':digest,'bytes':item['size'],'filename':item['filename']}


def validate_wheel(wheel,expanded=0,entries=0):
    check(wheel.lstat())
    with wheel.open('rb') as stream:
        stream.seek(max(0,wheel.stat().st_size-65557));tail=stream.read(65557)
    offset=tail.rfind(b'PK\x05\x06')
    if offset<0 or len(tail)-offset<22:raise ValueError('Malformed wheel central directory')
    signature,disk,central_disk,disk_entries,total_entries,central_size,central_offset,comment=struct.unpack_from('<4s4H2LH',tail,offset)
    if disk or central_disk or disk_entries!=total_entries or total_entries>20000 or central_size>4*1024*1024 or central_offset==0xffffffff or len(tail)-offset!=22+comment or central_offset+central_size>wheel.stat().st_size-22-comment:raise ValueError('Oversized or multi-disk wheel directory')
    seen=set()
    with zipfile.ZipFile(wheel) as archive:
        for entry in archive.infolist():
            expanded+=entry.file_size;entries+=1
            names=entry.filename.rstrip('/').split('/');key=entry.filename.casefold()
            if key in seen or entry.orig_filename!=entry.filename or entry.filename.startswith('/') or any(n in {'','..','.'} or ':' in n or '\\' in n for n in names) or stat.S_ISLNK(entry.external_attr>>16) or expanded>512*1024*1024 or entries>20000:raise ValueError('Unsafe or oversized wheel archive')
            seen.add(key)
    return expanded,entries


def uv_executable():
    import shutil
    roots=command_path().split(os.pathsep)+[str(Path.home()/'.local'/'bin'),str(Path(os.environ.get('LOCALAPPDATA',str(Path.home())))/'Programs'/'uv')]
    return shutil.which('uv',path=os.pathsep.join(roots))


def development_runtime(path):
    if path not in runtime_candidates(): raise ValueError('Choose a runtime executable returned by runtime.list')
    value=probe(path)
    if not value['valid'] or value['pcrc_internal'] or value['prefix']!=value['base_prefix']:
        raise ValueError('Choose a working full development Python, not PCRC or a project environment')
    return value


class Development:
    def __init__(self,commander):
        self.commander=commander
        self.store=PrivateStore(commander._store.path/'development',commander.workspace)
        self.active={};self.deadlines={}

    def load(self):
        try: blob=self.store.tree.read('plans.enc',2*1024*1024)
        except FileNotFoundError:return {}
        return json.loads(AESGCM(self.store.key).decrypt(blob[:12],blob[12:],self.store.context))

    def save(self,plans):
        if len(canonical(plans))>1024*1024:raise ValueError('Development receipt capacity reached')
        nonce=os.urandom(12)
        self.store.tree.write('plans.enc',nonce+AESGCM(self.store.key).encrypt(nonce,canonical(plans),self.store.context),overwrite=True)

    def update(self,identifier,**changes):
        with self.store.locked():
            plans=self.load();plans[identifier].update(changes)
            if changes.get('status') in {'completed','failed','unknown','previewed'}:
                plans[identifier]['last_duration_seconds']=round(time.time()-plans[identifier].get('operation_started_at',time.time()),3)
            self.save(plans)
        return plans[identifier]

    def full_runtime(self,path):
        if path in runtime_candidates():return development_runtime(path)
        with self.store.locked():plans=self.load()
        known=[p for p in plans.values() if p.get('status')=='completed' and p.get('review',{}).get('action')=='runtime.install' and p.get('result',{}).get('python',{}).get('executable')==path]
        if not known or sha(Path(path).read_bytes())!=known[-1]['result']['runtime_sha256']:raise ValueError('Select a discovered or PCRC-provisioned development runtime')
        value=probe(path)
        if not value['valid'] or value['pcrc_internal']:raise ValueError('Development runtime unavailable')
        return value

    def target(self,name):
        names=parts(name)
        if not names or names[-1]!='.venv':raise ValueError('Environment must be a project-relative .venv directory')
        with self.commander._tree.parent(name):pass
        path=self.commander.workspace.joinpath(*names)
        if path.exists():check(path.lstat(),directory=True)
        return path

    def marker(self,name):
        self.target(name)
        value=json.loads(self.commander._tree.read(name+'/pcrc-environment.json',4096))
        signature=value.pop('signature','')
        if not isinstance(signature,str) or not hmac.compare_digest(signature,hmac.new(self.store.key,canonical(value),'sha256').hexdigest()):raise ValueError('Environment ownership marker was altered')
        if value.get('workspace')!=sha(str(self.commander.workspace).encode()) or value.get('path')!=name:
            raise ValueError('Environment is not managed by PCRC in this workspace')
        return value

    def write_marker(self,name,value,overwrite=False):
        signed={**value,'signature':hmac.new(self.store.key,canonical(value),'sha256').hexdigest()}
        self.commander._tree.write(name+'/pcrc-environment.json',canonical(signed),overwrite=overwrite)

    def inventory(self,executable):
        result=self.read_command([executable,'-I','-c',"import importlib.metadata as m,json;print(json.dumps(sorted((d.metadata['Name'],d.version) for d in m.distributions())))"])
        if result['exit_code']!=0:raise ValueError('Cannot inspect installed package versions')
        return result['output']

    def interpreter(self,name):
        marker=self.marker(name)
        if marker.get('status')!='ready':raise ValueError('Environment incomplete; inspect its receipt before recovery')
        path=self.target(name)/('Scripts/python.exe' if os.name=='nt' else 'bin/python')
        check(path.lstat())
        value=probe(str(path))
        if not value['valid'] or Path(value['prefix']).resolve()!=self.target(name).resolve():raise ValueError('Project Python environment is unhealthy')
        return str(path)

    def dependencies(self,project):
        names=parts(project) if project!='.' else ()
        prefix='/'.join(names);sources={};specs=[]
        for leaf in ['requirements.txt','pyproject.toml']:
            name=(prefix+'/' if prefix else '')+leaf
            try: data=self.commander._tree.read(name,16384)
            except FileNotFoundError:continue
            assert_public_text(data)
            sources[name]=sha(data)
            if leaf.endswith('.toml'):
                document=tomllib.loads(data.decode());project_metadata=document.get('project',{})
                if not isinstance(project_metadata,dict) or 'dependencies' in project_metadata.get('dynamic',[]):raise ValueError('Dynamic project dependencies require a reviewed static requirements file')
                specs+=package_specs(project_metadata.get('dependencies',[]))
            else:specs+=[line.strip() for line in data.decode().splitlines() if line.strip() and not line.lstrip().startswith('#')]
        return {'project':project,'packages':package_specs(specs),'sources':sources,'build_scripts_executed':False}

    def inspect(self,action,options):
        if not isinstance(options,dict) or len(canonical(options))>16384:raise ValueError('Bounded development options required')
        assert_public_text(canonical(options))
        if action=='runtime.list':
            deadline=time.monotonic()+12;values=[]
            for path in runtime_candidates():
                if time.monotonic()>=deadline:break
                values.append(probe(path))
            with self.store.locked():managed=[p['result']['python'] for p in self.load().values() if p.get('status')=='completed' and p.get('review',{}).get('action')=='runtime.install']
            values.extend(probe(p['executable']) for p in managed[-8:])
            tools={}
            for name in ['node','npm','git','uv','rustc','cargo','dotnet','cmake','ninja','cl','gcc','clang']:
                import shutil
                executable=uv_executable() if name=='uv' else shutil.which(name,path=command_path())
                item={'path':executable,'verified':False};tools[name]=item
                if executable and not executable.lower().endswith(('.cmd','.bat')) and time.monotonic()<deadline:
                    try:
                        code,output=bounded_process([executable,'--version'],max(.1,min(1,deadline-time.monotonic())),Path.home(),4096)
                        item.update(verified=code==0,exit_code=code,version=output.decode('utf-8','replace').splitlines()[0][:200] if output else '')
                    except (OSError,ValueError,subprocess.TimeoutExpired):item['reason']='Version probe failed or timed out'
                elif executable:item['reason']='Version execution not verified within this bounded probe'
            return {'runtimes':values,'tool_paths':tools,'truncated':len(values)<len(runtime_candidates()),'uv_is_external_tool':True}
        if action in {'runtime.inspect','runtime.verify'}:
            path=options.get('runtime','')
            if path not in runtime_candidates():return self.full_runtime(path)
            return probe(path)
        if action=='project.detect_dependencies':return self.dependencies(options.get('project','.'))
        if action=='environment.list':
            project=options.get('project','.')
            return {'environments':[{'path':(project+'/' if project!='.' else '')+'.venv','marker':self.marker((project+'/' if project!='.' else '')+'.venv')}]} if self.target((project+'/' if project!='.' else '')+'.venv').exists() else {'environments':[]}
        name=options.get('environment','.venv')
        if action=='environment.inspect':return {'path':name,'marker':self.marker(name),'python':probe(str(self.target(name)/('Scripts/python.exe' if os.name=='nt' else 'bin/python')))}
        executable=self.interpreter(name)
        if action=='project.verify_environment':
            imports=options.get('imports',[])
            if not isinstance(imports,list) or len(imports)>20 or any(not isinstance(n,str) or len(n)>120 or not re.fullmatch('[A-Za-z_][A-Za-z_0-9]*(?:\\.[A-Za-z_][A-Za-z_0-9]*)*',n) for n in imports):raise ValueError('Use at most 20 ordinary import names')
            code="import importlib.util,json;print(json.dumps({n:importlib.util.find_spec(n.split('.')[0]) is not None for n in "+repr(imports)+"}))"
            return {'python':probe(executable),'imports':self.read_command([executable,'-I','-c',code]),'availability_only':True}
        if action=='package.list':
            code="import importlib.metadata as m,json;print(json.dumps([{'name':d.metadata['Name'],'version':d.version,'license':(d.metadata.get('License-Expression') or d.metadata.get('License') or '')[:200]} for d in list(m.distributions())[:300]]))"
            return {'packages':self.read_command([executable,'-I','-c',code])}
        if action=='package.audit':return self.audit_packages(executable,options.get('packages',[]))
        if action=='package.check':return self.read_command([executable,'-I','-m','pip','--isolated','check'])
        raise ValueError('Choose a supported development inspection action')

    def audit_packages(self,executable,names):
        import urllib.request, urllib.parse
        package_specs(names)
        if not isinstance(names,list) or not 1<=len(names)<=10 or any(not isinstance(n,str) or not re.fullmatch('[A-Za-z0-9][A-Za-z0-9._-]*',n) for n in names):raise ValueError('Audit 1..10 package names per call')
        versions=self.read_command([executable,'-I','-c',"import importlib.metadata as m,json;print(json.dumps({__import__('re').sub('[-_.]+','-',d.metadata['Name'].lower()):d.version for d in m.distributions()}))"])['output']
        class NoRedirect(urllib.request.HTTPRedirectHandler):
            def redirect_request(self,*args):raise ValueError('Unexpected advisory redirect')
        opener=urllib.request.build_opener(NoRedirect);results=[];deadline=time.monotonic()+10
        for name in names:
            version=versions.get(re.sub('[-_.]+','-',name.lower()))
            if version is None:results.append({'package':name,'status':'not_installed'});continue
            if time.monotonic()>=deadline:results.append({'package':name,'status':'not_checked','reason':'Audit deadline'});continue
            url='https://pypi.org/pypi/'+urllib.parse.quote(name,safe='')+'/'+urllib.parse.quote(version,safe='')+'/json'
            try:
                with opener.open(urllib.request.Request(url,headers={'User-Agent':'PCRemoteCommander/dependency-audit'}),timeout=max(.1,min(2,deadline-time.monotonic()))) as response:
                    raw=response.read(1024*1024+1)
                if len(raw)>1024*1024:raise ValueError('Advisory response too large')
                data=json.loads(raw);ids=[str(v.get('id',''))[:100] for v in data.get('vulnerabilities',[])[:100]]
                results.append({'package':name,'version':version,'status':'known_advisories' if ids else 'no_reported_advisories','advisory_ids':ids})
            except (OSError,ValueError):results.append({'package':name,'version':version,'status':'unverified','reason':'Advisory lookup unavailable'})
        return {'provider':'PyPI release JSON','results':results,'guarantees_safe':False,'shared_metadata':'Only requested package names and installed versions'}

    def read_command(self,argv):
        code,raw=bounded_process(argv,8,self.commander.workspace)
        text=raw.decode('utf-8','replace');assert_public_text(text)
        try:text=json.loads(text)
        except ValueError:pass
        return {'exit_code':code,'output':text}

    def preview(self,action,options):
        if action not in {'runtime.install','environment.create','environment.remove','package.install','package.uninstall','project.setup_environment'}:raise ValueError('Unsupported development change')
        if not isinstance(options,dict) or len(canonical(options))>16384 or set(options)-{'environment','runtime','packages','project','imports','version'}:raise ValueError('Unknown development options')
        assert_public_text(canonical(options))
        name=options.get('environment',(options.get('project','.')+'/' if options.get('project','.')!='.' else '')+'.venv');path=self.target(name)
        imports=options.get('imports',[])
        if not isinstance(imports,list) or len(imports)>20 or any(not isinstance(n,str) or len(n)>120 or not re.fullmatch('[A-Za-z_][A-Za-z_0-9]*(?:\\.[A-Za-z_][A-Za-z_0-9]*)*',n) for n in imports):raise ValueError('Use at most 20 ordinary import names')
        record={'action':action,'environment':name,'packages':package_specs(options.get('packages',[])),'index':INDEX,'imports':imports,'sources':{},'scripts':'Only binary wheels; no project builds, editable installs or shell commands','max_seconds':600,'download_limit_bytes':256*1024*1024,'expanded_wheel_limit_bytes':512*1024*1024,'quota_enforcement':'Private temporary/download storage monitored every 0.5 seconds; transient overshoot is possible'}
        if action=='runtime.install':
            version=options.get('version','');uv=uv_executable()
            if not re.fullmatch(r'3\.(?:1[1-9]|[2-9][0-9])\.[0-9]{1,3}',version):raise ValueError('Supply an exact Python 3.11+ release version')
            bootstrap=uv_bootstrap() if not uv else None
            destination=path.parent/('.pcrc-python-'+version)
            if destination.exists():raise FileExistsError('Runtime destination exists')
            record.update(runtime=uv or '',runtime_sha256=sha(Path(uv).read_bytes()) if uv else None,uv_bootstrap=bootstrap,version=version,runtime_destination=str(destination.relative_to(self.commander.workspace)),source='Original pinned PyPI uv wheel when needed; uv python-build-standalone distribution; per-project installation',packages=[])
        elif action in {'environment.create','project.setup_environment'}:
            if path.exists():raise FileExistsError('Environment already exists; inspect it, never overwrite')
            runtime=self.full_runtime(options.get('runtime',''))
            if not runtime['modules']['venv'] or not runtime['modules']['ensurepip']:raise ValueError('Full Python with venv and ensurepip is required; select another discovered runtime')
            record.update(runtime=runtime['executable'],runtime_sha256=sha(Path(runtime['executable']).read_bytes()))
        else:
            marker=self.marker(name)
            if action!='environment.remove':
                record['runtime']=self.interpreter(name)
                record['package_inventory_sha256']=sha(canonical(self.inventory(record['runtime'])))
            record['environment_marker_sha256']=sha(self.commander._tree.read(name+'/pcrc-environment.json',4096))
        if action=='project.setup_environment':
            dependencies=self.dependencies(options.get('project','.'));record.update(packages=package_specs(record['packages']+dependencies['packages']),sources=dependencies['sources'])
        if action=='package.uninstall' and any(not re.fullmatch('[A-Za-z0-9][A-Za-z0-9._-]*',n) for n in record['packages']):raise ValueError('Uninstall requires package names without options or versions')
        if action in {'package.install','package.uninstall'} and not record['packages']:raise ValueError('Supply packages')
        identifier=uuid.uuid4().hex
        plan={'plan_id':identifier,'status':'queued','created_at':time.time(),'expires_at':time.time()+900,'review':record,'sessions':[],'automatic_retry':False}
        with self.store.locked():
            plans=self.load()
            plans={k:v for k,v in plans.items() if v['created_at']>time.time()-86400*7 or v['status'] in {'preparing','applying','unknown'} or v['review']['action']=='runtime.install'}
            if len(plans)>=20:
                old=next((k for k,v in sorted(plans.items(),key=lambda item:item[1]['created_at']) if v['status'] in {'completed','failed'} and v['review']['action']!='runtime.install'),None)
                if old:del plans[old]
            if len(plans)>=20:raise ValueError('Development plan limit reached; review unresolved work')
            plans[identifier]=plan;self.save(plans)
        self.launch(identifier,self.prepare)
        return self.get(identifier)

    def worker_lock(self,identifier):
        name=identifier+'.worker'
        try:self.store.tree.write(name,b'0')
        except FileExistsError:pass
        fd=os.open(self.store.path/name,os.O_RDWR|getattr(os,'O_NOFOLLOW',0))
        try:
            if os.name=='nt':
                import msvcrt
                msvcrt.locking(fd,msvcrt.LK_NBLCK,1)
            else:
                import fcntl
                fcntl.flock(fd,fcntl.LOCK_EX|fcntl.LOCK_NB)
            return fd
        except OSError:os.close(fd);return None

    @staticmethod
    def unlock(fd):
        if os.name=='nt':
            import msvcrt
            os.lseek(fd,0,0);msvcrt.locking(fd,msvcrt.LK_UNLCK,1)
        else:
            import fcntl
            fcntl.flock(fd,fcntl.LOCK_UN)
        os.close(fd)

    def cleanup(self,identifier):
        for suffix in ['-stage']:
            path=self.store.path/(identifier+suffix)
            if path.exists():
                check(path.lstat(),directory=True)
                if not path.resolve().is_relative_to(self.store.path.resolve()):raise ValueError('Unsafe private staging cleanup')
                shutil.rmtree(path)

    def launch(self,identifier,fn):
        from .advanced import MAX_SESSIONS
        if len(self.active)>=MAX_SESSIONS:raise ValueError('Development worker capacity reached')
        fd=self.worker_lock(identifier)
        if fd is None:raise ValueError('Development worker already running')
        context=copy_context();context.run(coordinator(self.commander).depth.set,None)
        self.update(identifier,status='preparing' if fn.__name__=='prepare' else 'applying',operation_started_at=time.time())
        def execute():
            try:context.run(fn,identifier)
            except Exception as error:
                from .errors import public_error
                safe=public_error(error)
                self.update(identifier,status='unknown' if self.load()[identifier]['status']=='applying' else 'failed',error='Development operation failed or stopped. Inspect process logs and environment; never automatically replay.',error_code=safe['error_code'],diagnostic=safe['error'],automatic_retry=False)
            finally:
                try:self.cleanup(identifier)
                except (OSError,ValueError):self.update(identifier,staging_cleanup_incomplete=True)
                finally:self.active.pop(identifier,None);self.deadlines.pop(identifier,None);self.unlock(fd)
        thread=threading.Thread(target=execute,name='pcrc-development',daemon=True)
        self.active[identifier]=thread;self.deadlines[identifier]=time.monotonic()+600
        try:thread.start()
        except Exception:
            self.active.pop(identifier,None);self.deadlines.pop(identifier,None);self.unlock(fd)
            # A failed thread start has performed no worker actions. Restore
            # the reviewed plan only when the thread is definitely not alive.
            if not thread.is_alive():
                self.update(identifier,status='previewed',automatic_retry=False)
            else:
                self.update(identifier,status='unknown',error='Worker start outcome is uncertain; inspect before retrying',automatic_retry=False)
            raise

    def command(self,identifier,argv):
        self.commander._require_capability('commands');self.commander._require_capability('files')
        budget=int(self.deadlines.get(identifier,time.monotonic()+600)-time.monotonic())
        if budget<1:raise ValueError('Development operation deadline exceeded')
        stage=self.store.path/(identifier+'-stage');stage.mkdir(exist_ok=True)
        scratch=stage/'tmp';scratch.mkdir(exist_ok=True)
        if len(argv)>3 and argv[1:4]==['-I','-m','pip']:
            argv=[argv[0],'-I',str(Path(__file__).with_name('_development_pip.py')),str(stage),*argv[4:]]
        environment=self.commander._environment()
        environment.update(PIP_CONFIG_FILE=os.devnull,UV_NO_CONFIG='1',TMPDIR=str(scratch),TEMP=str(scratch),TMP=str(scratch),UV_CACHE_DIR=str(scratch/'uv-cache'),UV_NO_CACHE='1')
        # Hold the workspace operation record and OS resource lock for the
        # entire subprocess lifetime, not merely until Popen returns.
        with coordinator(self.commander).guard(['workspace']):
            result=self.commander._start_controlled_argv(argv,budget,environment=environment)
            if assignment.get():self.commander._sessions[result['session_id']]['task_id']=assignment.get()[0]
            entry=self.commander._sessions[result['session_id']]
            try:
                with self.store.locked():
                    plans=self.load();plans[identifier]['sessions'].append(result['session_id']);self.save(plans)
                while not entry['done'].wait(.5):
                    self.commander._require_capability('commands');self.commander._require_capability('files')
                    if current:=assignment.get():
                        store=coordinator(self.commander)
                        with store.store.locked():store.validate(store.load()['tasks'][current[0]],current[1])
                    self.check_disk_budget(identifier,scratch)
                self.check_disk_budget(identifier,scratch)
                output=self.commander.process_output(result['session_id'],length=16384)
                if output['exit_code']!=0 or output['timed_out'] or output['truncated']:
                    text=bytes(entry['output']).decode('utf-8','replace');assert_public_text(text)
                    self.update(identifier,last_process_exit_code=output['exit_code'],last_process_error=text[-2000:])
                    raise ValueError('Development subprocess failed, timed out or was cancelled')
                return output
            finally:
                if not entry['done'].is_set():self.commander.stop_session(result['session_id'])

    def check_disk_budget(self,identifier,scratch):
        plan=self.load()[identifier];review=plan['review']
        roots=[(self.store.path/(identifier+'-stage'),256*1024*1024)]
        target=self.commander.workspace.joinpath(*parts(review.get('runtime_destination',review['environment'])))
        roots.append((target,1024*1024*1024))
        for root,limit in roots:
            if not root.exists():continue
            total=0;count=0
            for current,dirs,files in os.walk(root,followlinks=False):
                count+=len(dirs)+len(files)
                if count>30000:raise ValueError('Development file-count quota exceeded')
                for name in dirs+files:
                    path=Path(current)/name
                    try:
                        info=path.lstat()
                        if path.is_symlink():
                            if not path.resolve().is_relative_to(root.resolve()):raise ValueError('Development staging/runtime link escape denied')
                        elif name in files:check(info);total+=info.st_size
                    except FileNotFoundError:continue
                    if total>limit:raise ValueError('Development staging/runtime disk quota exceeded')


    def prepare(self,identifier):
        plan=self.get(identifier);review=plan['review'];packages=review['packages']
        self.update(identifier,phase='dependency_resolution' if packages else 'preparing_review')
        if packages and review['action']!='package.uninstall':
            # Resolve wheels before user approval; installation uses exactly these hashes.
            runtime=review['runtime'];stage=self.store.path/(identifier+'-stage');stage.mkdir(exist_ok=True);report=stage/'report.json'
            if not probe(runtime).get('modules',{}).get('pip'):
                resolver=stage/'resolver'
                self.command(identifier,[runtime,'-I','-m','venv','--copies',str(resolver)])
                runtime=str(resolver/('Scripts/python.exe' if os.name=='nt' else 'bin/python'))
            self.command(identifier,[runtime,'-I','-m','pip','--isolated','--disable-pip-version-check','install','--dry-run','--ignore-installed','--only-binary=:all:','--no-input','--no-cache-dir','--index-url',INDEX,'--report',str(report),*packages])
            data=json.loads(self.store.tree.read(identifier+'-stage/report.json',1024*1024));resolved=[]
            for item in data.get('install',[]):
                metadata=item['metadata'];download=item['download_info'];url=download['url']
                from urllib.parse import urlsplit
                parsed=urlsplit(url);digest=download.get('archive_info',{}).get('hashes',{}).get('sha256','')
                if parsed.scheme!='https' or parsed.hostname!='files.pythonhosted.org' or parsed.username or parsed.password or parsed.query or parsed.fragment or not parsed.path.endswith('.whl') or not re.fullmatch('[a-f0-9]{64}',digest):raise ValueError('Only hashed original PyPI wheels are supported')
                spec=metadata['name']+'=='+metadata['version'];package_specs([spec])
                resolved.append({'package':spec,'sha256':digest,'license':str(metadata.get('license',''))[:200]})
            if not resolved or len(resolved)>80:raise ValueError('Dependency resolution exceeds 80 wheels')
            review['resolved']=resolved;review['size_estimate']='Unknown until download; staging monitored against 256 MiB with possible transient overshoot'
        if len(canonical(review))>24000:raise ValueError('Development review too large; use fewer packages')
        self.update(identifier,status='previewed',review=review,review_sha256=sha(canonical(review)))

    def get(self,identifier):
        if not isinstance(identifier,str) or not re.fullmatch('[a-f0-9]{32}',identifier):raise ValueError('Invalid development plan ID')
        with self.store.locked():
            plans=self.load();plan=plans.get(identifier)
            if plan is None:raise ValueError('Development plan not found')
            if plan['status'] in {'queued_for_apply','preparing','applying'} and identifier not in self.active:
                fd=self.worker_lock(identifier)
                if fd is not None:
                    self.unlock(fd)
                    plan.update(status='unknown',error='Agent stopped before the worker could be confirmed active; inspect the environment and logs; no replay',automatic_retry=False);self.save(plans)
            return {**plan,'poll_after_seconds':2}

    def apply(self,identifier,review_sha256):
        self.get(identifier)
        with self.store.locked():
            plans=self.load();plan=plans[identifier]
            if plan['status']!='previewed' or plan['expires_at']<=time.time() or plan['review_sha256']!=review_sha256:raise ValueError('Review stale, altered, expired or already used')
            plan['status']='queued_for_apply';self.save(plans)
        try:
            self.launch(identifier,self.execute)
        except Exception:
            # Capacity/lock rejection occurs before execution. If the worker
            # never advanced the durable state, restore the reviewed plan.
            with self.store.locked():
                plans=self.load();current=plans.get(identifier)
                if current and current.get('status')=='queued_for_apply':
                    current['status']='previewed';self.save(plans)
            raise
        return self.get(identifier)

    def execute(self,identifier):
        plan=self.get(identifier)
        lock=PrivateStore(self.store.path/('environment-'+sha(plan['review']['environment'].encode())),self.commander.workspace)
        with lock.locked():self.execute_locked(identifier)

    def execute_locked(self,identifier):
        plan=self.get(identifier);review=plan['review'];name=review['environment'];action=review['action'];tree=self.commander._tree
        target=self.target(name)
        if action=='runtime.install':
            self.update(identifier,phase='provisioning_runtime')
            destination=self.commander.workspace.joinpath(*parts(review['runtime_destination']))
            with coordinator(self.commander).guard(['workspace']):
                if destination.exists():raise FileExistsError('Runtime destination already exists')
                if review['runtime'] and sha(Path(review['runtime']).read_bytes())!=review['runtime_sha256']:raise ValueError('uv executable changed')
            uv=review['runtime']
            if bootstrap:=review.get('uv_bootstrap'):
                import urllib.request
                stage=self.store.path/(identifier+'-stage');stage.mkdir(exist_ok=True)
                wheel=stage/'uv.whl';digest=hashlib.sha256();size=0
                with public_open(bootstrap['url'],20) as response,wheel.open('xb') as output:
                    if response.geturl()!=bootstrap['url']:raise ValueError('Unexpected uv download redirect')
                    while chunk:=response.read(1024*1024):
                        self.commander._require_capability('commands');size+=len(chunk)
                        if size>bootstrap['bytes']:raise ValueError('uv artifact size changed')
                        digest.update(chunk);output.write(chunk)
                if size!=bootstrap['bytes'] or digest.hexdigest()!=bootstrap['sha256']:raise ValueError('uv artifact checksum mismatch')
                validate_wheel(wheel)
                with zipfile.ZipFile(wheel) as archive:
                    matches=[e for e in archive.infolist() if e.filename.split('/')[-1]==('uv.exe' if os.name=='nt' else 'uv') and not e.is_dir()]
                    if len(matches)!=1 or matches[0].file_size>80*1024*1024:raise ValueError('uv executable missing or oversized')
                    executable=stage/('uv.exe' if os.name=='nt' else 'uv')
                    with archive.open(matches[0]) as source,executable.open('xb') as output:shutil.copyfileobj(source,output,1024*1024)
                    executable.chmod(0o700);uv=str(executable)
            self.command(identifier,[uv,'--no-config','python','install',review['version'],'--install-dir',str(destination),'--no-bin','--no-registry'])
            candidates=list(destination.glob('*/python.exe')) if os.name=='nt' else list(destination.glob('*/bin/python3'))
            valid=[probe(str(p)) for p in candidates[:8] if p.resolve().is_relative_to(destination.resolve())]
            actual=next((v for v in valid if v['valid'] and v['version']==review['version']),None)
            if actual is None:raise ValueError('Provisioned runtime could not be verified')
            self.update(identifier,status='completed',result={'python':actual,'runtime_sha256':sha(Path(actual['executable']).read_bytes()),'verified':True});return
        for source,digest in review['sources'].items():
            if sha(tree.read(source,16384))!=digest:raise ValueError('Project dependency file changed')
        if 'environment_marker_sha256' in review and sha(tree.read(name+'/pcrc-environment.json',4096))!=review['environment_marker_sha256']:raise ValueError('Environment changed since preview')
        if 'package_inventory_sha256' in review and sha(canonical(self.inventory(self.interpreter(name))))!=review['package_inventory_sha256']:raise ValueError('Installed package versions changed since preview')
        if action in {'environment.create','project.setup_environment'}:
            self.update(identifier,phase='creating_environment')
            with coordinator(self.commander).guard(['workspace']):
                if target.exists():raise FileExistsError('Environment exists')
                if sha(Path(review['runtime']).read_bytes())!=review['runtime_sha256']:raise ValueError('Development runtime changed')
                tree.mkdir(name)
                marker={'workspace':sha(str(self.commander.workspace).encode()),'path':name,'status':'creating','plan_id':identifier}
                self.write_marker(name,marker)
            self.command(identifier,[review['runtime'],'-I','-m','venv','--copies',str(target)])
            actual=probe(str(target/('Scripts/python.exe' if os.name=='nt' else 'bin/python')))
            if not actual['valid'] or not actual['modules']['pip']:raise ValueError('Created environment is missing Python or pip')
            with coordinator(self.commander).guard(['workspace']):
                marker['status']='ready';self.write_marker(name,marker,overwrite=True)
        if action=='environment.remove':
            self.update(identifier,phase='moving_to_recovery')
            backup=target.with_name('.venv.removed-'+identifier)
            if backup.exists():raise FileExistsError('Recovery destination exists')
            with coordinator(self.commander).guard(['workspace']):
                self.marker(name)
                os.rename(target,backup)
            self.update(identifier,status='completed',result={'removed':name,'recoverable_directory':str(backup.relative_to(self.commander.workspace))});return
        executable=self.interpreter(name)
        if review.get('resolved'):
            self.update(identifier,phase='downloading_wheels')
            stage=self.store.path/(identifier+'-stage');stage.mkdir(exist_ok=True);wheelhouse=stage/'wheels';wheelhouse.mkdir()
            requirements='\n'.join(item['package']+' --hash=sha256:'+item['sha256'] for item in review['resolved'])+'\n'
            self.store.tree.write(identifier+'-stage/requirements.txt',requirements.encode())
            self.command(identifier,[executable,'-I','-m','pip','--isolated','--disable-pip-version-check','download','--only-binary=:all:','--no-deps','--no-cache-dir','--index-url',INDEX,'--require-hashes','-r',str(stage/'requirements.txt'),'--dest',str(wheelhouse)])
            wheels=list(wheelhouse.iterdir())
            if len(wheels)>80 or sum(p.stat().st_size for p in wheels)>256*1024*1024:raise ValueError('Wheel downloads exceed size limit')
            expanded=0;entries=0
            for wheel in wheels:expanded,entries=validate_wheel(wheel,expanded,entries)
            self.update(identifier,phase='installing_reviewed_wheels')
            self.command(identifier,[executable,'-I','-m','pip','--isolated','--disable-pip-version-check','install','--no-input','--no-index','--no-deps','--require-hashes','--find-links',str(wheelhouse),'-r',str(stage/'requirements.txt')])
        elif action=='package.uninstall':self.command(identifier,[executable,'-I','-m','pip','--isolated','uninstall','--yes',*review['packages']])
        self.update(identifier,phase='verifying_environment')
        self.command(identifier,[executable,'-I','-m','pip','--isolated','check'])
        value=probe(executable)
        if not value['valid'] or not value['modules']['pip']:raise ValueError('Saved environment failed reopen verification')
        if review['imports']:
            self.command(identifier,[executable,'-I','-c',"import importlib;[importlib.import_module(n) for n in "+repr(review['imports'])+"];print('PCRC_IMPORTS_VERIFIED')"])
        self.update(identifier,status='completed',result={'python':value,'pip_check_exit_code':0,'verified':True,'imports_verified':review['imports']})


def main(argv,workspace=None):
    import argparse
    from .cli import workspace_path
    from .control import ControlCommander
    parser=argparse.ArgumentParser(description='PCRC reviewed project Python environments')
    parser.add_argument('operation',choices=['inspect','preview','receipt','apply'])
    parser.add_argument('--action');parser.add_argument('--options',default='{}');parser.add_argument('--plan-id');parser.add_argument('--review-sha256');parser.add_argument('--allow-changes',action='store_true')
    args=parser.parse_args(argv);pc=ControlCommander(workspace_path(workspace),enabled={'commands','files'},duration_minutes=480)
    pc.allow_writes=args.allow_changes
    try:
        service=Development(pc)
        if args.operation=='inspect':result=service.inspect(args.action,json.loads(args.options))
        elif args.operation=='receipt':result=service.get(args.plan_id)
        elif args.operation=='preview':result=service.preview(args.action,json.loads(args.options))
        else:
            if not args.allow_changes:raise ValueError('Apply requires --allow-changes')
            result=service.apply(args.plan_id,args.review_sha256)
        if args.operation in {'preview','apply'}:
            while result['status'] in {'preparing','applying'}:time.sleep(.2);result=service.get(result['plan_id'])
        if args.operation in {'preview','apply'}:
            worker=service.active.get(result['plan_id'])
            if worker:worker.join(timeout=10)
            result=service.get(result['plan_id'])
            if worker and worker.is_alive():result['staging_cleanup_incomplete']=True
        print(json.dumps(result));return 0 if result.get('status') not in {'failed','unknown'} else 1
    except (ValueError,OSError,RuntimeError) as error:
        from .errors import public_error
        print(json.dumps(public_error(error)));return 1
    finally:pc.close_control()
