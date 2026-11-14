"""Exercise package integrity and reconnect behavior without network or OS changes."""
import hashlib
import io
import json
import os
from pathlib import Path
import subprocess
import sys
from types import SimpleNamespace
from unittest.mock import Mock
from zipfile import ZipFile

import pytest
from scripts.build_posix_candidate import build
from urllib.request import Request


def requested_url(value):
    if isinstance(value,Request):
        assert value.get_header('User-agent')=='PCRemoteCommander/installer'
        return value.full_url
    return value


def test_posix_candidate_verifies_download_and_reuses_install(tmp_path, monkeypatch):
    archive, launcher, digest = build(tmp_path / 'output', '0.7.0-beta.28')
    payload = archive.read_bytes()
    assert hashlib.sha256(payload).hexdigest() == digest
    with ZipFile(archive) as package:
        names = set(package.namelist())
        assert {'pcrc-connect.sh', 'setup-macos.sh', 'deploy/npm/jan-commander/bin/doctor.cjs'} <= names
        assert not any({'vendor', 'node_modules', '__pycache__'} & set(Path(name).parts) for name in names)
        assert 'connection.json' not in names

    code = launcher.read_text().split("<<'PY'\n", 1)[1].split('\nPY\n', 1)[0]
    monkeypatch.setattr(sys, 'argv', ['-', '0.7.0-beta.28', digest, 'setup'])
    monkeypatch.setitem(sys.modules, 'fcntl', SimpleNamespace(flock=Mock(), LOCK_EX=2))
    monkeypatch.setattr(Path, 'home', lambda: tmp_path)
    monkeypatch.setattr(os, 'chdir', Mock())
    monkeypatch.setattr(os, 'execvp', Mock())
    monkeypatch.setattr(os, 'dup2', Mock())
    monkeypatch.delenv('PCRC_DESKTOP', raising=False)
    monkeypatch.delenv('PCRC_BOOTSTRAP_NODE', raising=False)
    def setup(_args, **kwargs):
        Path(kwargs['cwd'],'connection.json').write_text(json.dumps({'workspace':str(tmp_path/'PCRC-Workspace')}))
    install = Mock(side_effect=setup)
    monkeypatch.setattr(subprocess, 'run', install)
    def response(url, **_kwargs):
        url=requested_url(url)
        stream = io.BytesIO(payload)
        stream.url = url
        return stream
    download = Mock(side_effect=response)
    monkeypatch.setattr('urllib.request.urlopen', download)

    payload = b'corrupted'
    with pytest.raises(SystemExit, match='integrity'):
        exec(code, {})
    assert not install.called
    payload = archive.read_bytes()
    exec(code, {})
    exec(code, {})
    assert download.call_count == 2
    assert isinstance(download.call_args.args[0],Request)
    assert install.call_count == 1
    assert os.execvp.call_count == 2
    with ZipFile(archive) as package:
        assert '0.7.0-beta.28' in package.read('src/jan_mcp_commander/__init__.py').decode()
        assert '0.7.0-beta.28' in package.read('deploy/npm/jan-commander/package.json').decode()

    monkeypatch.setattr(sys,'argv',['-','0.7.0-beta.28',digest,'--cli','read file','notes $(unsafe).txt'])
    direct=Mock(side_effect=SystemExit(0));monkeypatch.setattr(os,'execv',direct)
    with pytest.raises(SystemExit) as cli_exit:
        exec(code,{})
    assert cli_exit.value.code==0
    executable,vector=direct.call_args.args
    assert Path(executable).parts[-3:]==('.venv','bin','python')
    assert vector[-2:]==['read file','notes $(unsafe).txt']
    assert os.execvp.call_count==2

    keep = tmp_path/'PCRC-Workspace';keep.mkdir(exist_ok=True);(keep/'personal.txt').write_text('preserve')
    target = next((tmp_path/'.pcrc/releases').glob('0.7.0-beta.28-*'))
    monkeypatch.setattr(sys, 'argv', ['-', '0.7.0-beta.28', digest, '--uninstall'])
    with pytest.raises(SystemExit) as stopped:
        exec(code, {})
    assert stopped.value.code == 0
    assert not target.exists()
    assert (keep/'personal.txt').read_text() == 'preserve'
    assert download.call_count == 2


def test_posix_package_rejects_unsafe_archives_and_directory_links(tmp_path, monkeypatch):
    archive, launcher, digest = build(tmp_path/'output','0.7.0-beta.28')
    code=launcher.read_text().split("<<'PY'\n",1)[1].split('\nPY\n',1)[0]
    monkeypatch.setattr(Path,'home',lambda:tmp_path)
    monkeypatch.setitem(sys.modules,'fcntl',SimpleNamespace(flock=Mock(),LOCK_EX=2))
    monkeypatch.delenv('PCRC_BOOTSTRAP_NODE',raising=False)
    # Model POSIX ZIP parsing: Windows zipfile otherwise normalizes backslashes.
    monkeypatch.setattr(os,'sep','/')
    monkeypatch.setattr(os,'chdir',Mock())
    monkeypatch.setattr(os,'execvp',Mock(side_effect=lambda *args:pytest.fail('unsafe archive unexpectedly launched: '+name)))
    install=Mock();monkeypatch.setattr(subprocess,'run',install)
    for name in ['../outside.txt','/absolute.txt','folder\\outside.txt','A.txt']:
        stream=io.BytesIO()
        with ZipFile(stream,'w') as bad:
            bad.writestr(name,'unsafe')
            if name=='A.txt':bad.writestr('a.txt','duplicate')
        payload=stream.getvalue();bad_digest=hashlib.sha256(payload).hexdigest()
        monkeypatch.setattr(sys,'argv',['-','0.7.0-beta.28',bad_digest,'setup'])
        def response(url,**kwargs):
            url=requested_url(url)
            source=io.BytesIO(payload);source.url=url;return source
        monkeypatch.setattr('urllib.request.urlopen',response)
        with pytest.raises(SystemExit,match='unsafe path'):
            exec(code,{})
    assert not install.called
    assert not (tmp_path/'outside.txt').exists()


def test_posix_node_bootstrap_rejects_checksum_mismatch(tmp_path, monkeypatch):
    _,launcher,digest=build(tmp_path/'output','0.7.0-beta.28')
    code=launcher.read_text().split("<<'PY'\n",1)[1].split('\nPY\n',1)[0]
    monkeypatch.setattr(Path,'home',lambda:tmp_path)
    monkeypatch.setattr(sys,'argv',['-','0.7.0-beta.28',digest,'setup'])
    monkeypatch.setitem(sys.modules,'fcntl',SimpleNamespace(flock=Mock(),LOCK_EX=2))
    monkeypatch.setenv('PCRC_BOOTSTRAP_NODE','1')
    monkeypatch.setenv('PATH',os.environ.get('PATH',''))
    monkeypatch.setattr('platform.system',lambda:'Linux');monkeypatch.setattr('platform.machine',lambda:'x86_64')
    def response(url,**kwargs):
        url=requested_url(url)
        assert url=='https://nodejs.org/dist/v24.20.0/node-v24.20.0-linux-x64.tar.gz'
        value=io.BytesIO(b'corrupted');value.url=url;return value
    monkeypatch.setattr('urllib.request.urlopen',response)
    install=Mock();monkeypatch.setattr(subprocess,'run',install)
    with pytest.raises(SystemExit,match='Node.js download failed integrity'):
        exec(code,{})
    assert not install.called


def test_posix_node_bootstrap_is_user_scoped_verified_and_cached(tmp_path,monkeypatch):
    import tarfile
    archive,launcher,digest=build(tmp_path/'output','0.7.0-beta.28')
    code=launcher.read_text().split("<<'PY'\n",1)[1].split('\nPY\n',1)[0]
    source=io.BytesIO();name='node-v24.20.0-linux-x64'
    with tarfile.open(fileobj=source,mode='w:gz') as bundle:
        for relative in ['bin/node','lib/node_modules/npm/bin/npm-cli.js','lib/node_modules/npm/bin/npx-cli.js']:
            content=b'synthetic runtime';item=tarfile.TarInfo(name+'/'+relative);item.size=len(content);item.mode=0o755;bundle.addfile(item,io.BytesIO(content))
    node_data=source.getvalue()
    code=code.replace('855d581f8a4eb1a8117e3426de25fe02770592febcfb31369aee1ffbfee9e8ec',hashlib.sha256(node_data).hexdigest())
    monkeypatch.setattr(Path,'home',lambda:tmp_path)
    monkeypatch.setattr(sys,'argv',['-','0.7.0-beta.28',digest,'setup'])
    monkeypatch.setitem(sys.modules,'fcntl',SimpleNamespace(flock=Mock(),LOCK_EX=2))
    monkeypatch.setenv('PCRC_BOOTSTRAP_NODE','1')
    monkeypatch.setenv('PATH',os.environ.get('PATH',''))
    monkeypatch.setattr('platform.system',lambda:'Linux');monkeypatch.setattr('platform.machine',lambda:'x86_64')
    monkeypatch.setattr(Path,'symlink_to',lambda self,target:self.write_text('synthetic-link:'+target))
    monkeypatch.setattr(os,'chdir',Mock());monkeypatch.setattr(os,'execvp',Mock())
    monkeypatch.setattr(os,'dup2',Mock())
    def setup(args,**kwargs):
        if args[0]=='bash':Path(kwargs['cwd'],'connection.json').write_text(json.dumps({'workspace':str(tmp_path/'PCRC-Workspace')}))
    install=Mock(side_effect=setup);monkeypatch.setattr(subprocess,'run',install)
    downloads=[]
    def response(url,**kwargs):
        url=requested_url(url)
        downloads.append(url);data=node_data if 'nodejs.org' in url else archive.read_bytes()
        value=io.BytesIO(data);value.url=url;return value
    monkeypatch.setattr('urllib.request.urlopen',response)
    exec(code,{})
    exec(code,{})
    assert len(downloads)==2
    assert (tmp_path/'.pcrc/tools'/name/'bin/node').is_file()
    assert install.call_count==3  # two version checks and a single PCRC setup
    assert os.execvp.call_count==2


def test_posix_upgrade_preserves_custom_workspace_and_pairing_location(tmp_path,monkeypatch):
    monkeypatch.setattr(Path,'home',lambda:tmp_path)
    monkeypatch.setitem(sys.modules,'fcntl',SimpleNamespace(flock=Mock(),LOCK_EX=2))
    monkeypatch.delenv('PCRC_BOOTSTRAP_NODE',raising=False)
    monkeypatch.setattr(os,'chdir',Mock());monkeypatch.setattr(os,'execvp',Mock());monkeypatch.setattr(os,'dup2',Mock())
    custom=tmp_path/'Documents'/'My approved workspace'
    monkeypatch.setenv('JAN_MCP_WORKSPACE',str(custom))
    installs=[]
    def setup(args,**kwargs):
        if args[0]=='node':return
        installs.append(args)
        Path(kwargs['cwd'],'connection.json').write_text(json.dumps({'workspace':args[-1]}))
    monkeypatch.setattr(subprocess,'run',setup)
    def release(version):
        archive,launcher,digest=build(tmp_path/version,version)
        code=launcher.read_text().split("<<'PY'\n",1)[1].split('\nPY\n',1)[0]
        def response(url,**kwargs):
            url=requested_url(url)
            stream=io.BytesIO(archive.read_bytes());stream.url=url;return stream
        monkeypatch.setattr('urllib.request.urlopen',response)
        monkeypatch.setattr(sys,'argv',['-',version,digest,'setup'])
        exec(code,{})
        return code,digest
    first,digest=release('0.7.0-beta.28')
    (custom/'sample.txt').write_text('preserve this document')
    monkeypatch.delenv('JAN_MCP_WORKSPACE')
    release('0.7.0-beta.29')
    assert [args[-1] for args in installs]==[str(custom),str(custom)]
    assert json.loads((tmp_path/'.pcrc/workspace.json').read_text())=={'workspace':str(custom)}
    assert not (tmp_path/'.local/state').exists()  # No pairing/key initialization by the installer.
    monkeypatch.setattr(sys,'argv',['-','0.7.0-beta.28',digest,'--uninstall'])
    with pytest.raises(SystemExit) as removed:exec(first,{})
    assert removed.value.code==0
    assert (custom/'sample.txt').read_text()=='preserve this document'
    assert json.loads((tmp_path/'.pcrc/workspace.json').read_text())['workspace']==str(custom)


@pytest.mark.parametrize('invalid_config',[False,True])
def test_posix_uninstall_refuses_nested_workspace_or_invalid_configuration(tmp_path,monkeypatch,invalid_config):
    _,launcher,digest=build(tmp_path/'output','0.7.0-beta.28')
    code=launcher.read_text().split("<<'PY'\n",1)[1].split('\nPY\n',1)[0]
    target=tmp_path/'.pcrc/releases'/('0.7.0-beta.28-'+digest[:12]);target.mkdir(parents=True)
    workspace=target/'my-workspace';workspace.mkdir();(workspace/'personal.txt').write_text('must survive')
    (target/'connection.json').write_text('invalid JSON' if invalid_config else json.dumps({'workspace':str(workspace)}))
    monkeypatch.setattr(Path,'home',lambda:tmp_path)
    monkeypatch.setitem(sys.modules,'fcntl',SimpleNamespace(flock=Mock(),LOCK_EX=2))
    monkeypatch.setattr(sys,'argv',['-','0.7.0-beta.28',digest,'--uninstall'])
    with pytest.raises(SystemExit,match='Nothing was removed'):
        exec(code,{})
    assert (workspace/'personal.txt').read_text()=='must survive'


def test_source_setup_rejects_workspace_inside_installation(tmp_path,monkeypatch):
    root=Path(__file__).resolve().parents[1]
    code=(root/'setup-linux.sh').read_text().split("<<'PY'\n",1)[1].split('\nPY\n',1)[0]
    installation=tmp_path/'pcrc';installation.mkdir()
    monkeypatch.chdir(installation)
    monkeypatch.setattr(sys,'argv',['-',str(installation/'my-workspace')])
    with pytest.raises(SystemExit,match='separate'):
        exec(code,{})
    assert not (installation/'my-workspace').exists()
    assert not (installation/'connection.json').exists()


@pytest.mark.parametrize('case',['success','checksum','unsafe_path','unsafe_link'])
def test_shell_python_bootstrap_verifies_and_caches_without_system_python(tmp_path,case):
    import tarfile
    import shutil
    bash=Path('C:/Program Files/Git/bin/bash.exe') if os.name=='nt' else Path(shutil.which('bash') or '/not-installed')
    if not bash.exists() or hasattr(os,'geteuid') and os.geteuid()==0:
        pytest.skip('Shell bootstrap test needs Bash under a normal user')
    root=Path(__file__).resolve().parents[1]
    home=tmp_path/'home';home.mkdir();commands=tmp_path/'commands';commands.mkdir()
    log=tmp_path/'interpreter.log';downloads=tmp_path/'downloads.log';archive=tmp_path/'python.tar.gz'
    interpreter=b'#!/usr/bin/env bash\nif [[ "$1" == -I ]]; then shift; fi\nif [[ "$1" == -c ]]; then exit 0; fi\nprintf "%s\\n" "$@" >> "$PCRC_TEST_LOG"\ncat >/dev/null\n'
    with tarfile.open(archive,'w:gz') as bundle:
        name='../outside' if case=='unsafe_path' else 'python/bin/python3.13'
        item=tarfile.TarInfo(name);item.mode=0o755
        if case=='unsafe_link':item.type=tarfile.SYMTYPE;item.linkname='/outside-python'
        else:item.size=len(interpreter)
        bundle.addfile(item,None if case=='unsafe_link' else io.BytesIO(interpreter))
    template=(root/'scripts/install-posix.sh.in').read_text()
    expected='0'*64 if case=='checksum' else hashlib.sha256(archive.read_bytes()).hexdigest()
    template=template.replace('df15fe60d3ff55bf9dcf25824b5572756bb8816ff93865a273d3301d7066a8b7',expected)
    script=tmp_path/'installer.sh';script.write_text(template,newline='\n')
    stubs={
        'python3':'#!/usr/bin/env bash\nexit 1\n',
        'uname':'#!/usr/bin/env bash\nif [[ "$1" == -s ]]; then echo Linux; else echo x86_64; fi\n',
        'curl':'#!/usr/bin/env bash\necho download >> "$PCRC_TEST_DOWNLOADS"\nwhile [[ $# -gt 0 ]]; do if [[ "$1" == --output ]]; then cp "$PCRC_TEST_ARCHIVE" "$2"; exit; fi; shift; done\nexit 1\n',
    }
    for name,content in stubs.items():
        path=commands/name;path.write_text(content,newline='\n');path.chmod(0o755)
    def unix(path):
        value=path.as_posix()
        return '/'+value[0].lower()+value[2:] if os.name=='nt' else value
    env={**os.environ,'HOME':unix(home),'PCRC_TEST_LOG':unix(log),'PCRC_TEST_ARCHIVE':unix(archive),'PCRC_TEST_DOWNLOADS':unix(downloads)}
    import shlex
    command='export PATH='+shlex.quote(unix(commands))+':"$PATH"; exec bash '+shlex.quote(unix(script))
    syntax=subprocess.run([str(bash),'-n',str(script)],env=env,capture_output=True,text=True)
    assert syntax.returncode==0,syntax.stderr
    result=subprocess.run([str(bash),'-c',command],env=env,capture_output=True,text=True,timeout=25)
    if case=='success':
        assert result.returncode==0,result.stdout+result.stderr
        assert log.exists()
        second=subprocess.run([str(bash),'-c',command],env=env,capture_output=True,text=True,timeout=25)
        assert second.returncode==0,second.stdout+second.stderr
        assert downloads.read_text().splitlines()==['download']
        assert (home/'.pcrc/tools/python-3.13.18-20261026-x86_64-unknown-linux-gnu/bin/python3.13').is_file()
    else:
        assert result.returncode!=0
        assert not log.exists()
        assert not (home/'outside').exists()
