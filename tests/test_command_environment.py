"""Command lookup remains deterministic and independent of ambient application secrets."""
import os
import shutil

import pytest
from jan_mcp_commander.control import ControlCommander


@pytest.mark.skipif(os.name != 'nt', reason='Installed Windows Node/Git regression')
@pytest.mark.parametrize('shell',['powershell','cmd'])
@pytest.mark.parametrize('tool,installed', [('node',r'C:\Program Files\nodejs\node.exe'),('git',r'C:\Program Files\Git\cmd\git.exe')])
def test_installed_command_is_discoverable_without_ambient_path(tmp_path,monkeypatch,tool,installed,shell):
    assert os.path.isfile(installed), 'This fixture requires the installed command'
    workspace=tmp_path/'workspace';workspace.mkdir()
    monkeypatch.setenv('JAN_MCP_STATE_DIR',str(tmp_path/'private'))
    monkeypatch.setenv('PATH',str(workspace))
    monkeypatch.setenv('PCRC_SYNTHETIC_API_SECRET','do-not-inherit')
    commander=ControlCommander(workspace,enabled={'commands'})
    try:
        env=commander._environment()
        assert (shutil.which(tool,path=env['PATH']) or '').casefold() == installed.casefold()
        assert str(workspace) not in env['PATH']
        assert 'PCRC_SYNTHETIC_API_SECRET' not in env
        result=commander.run_command(tool+' --version',shell=shell)
        assert result['exit_code']==0,result
        assert result['output'].strip()
    finally:
        commander.close_control()


@pytest.mark.parametrize('platform,executable,expected', [
    ('linux','/pcrc/python/bin/python',['/usr/bin','/bin','/pcrc/python/bin','/usr/local/bin']),
    ('darwin','/pcrc/python/bin/python',['/usr/bin','/bin','/pcrc/python/bin','/usr/local/bin','/opt/homebrew/bin']),
])
def test_posix_command_roots_are_deterministic(platform,executable,expected):
    from jan_mcp_commander.environment import _command_directories
    assert _command_directories(platform,{'PATH':'.:/attacker','API_SECRET':'private'},executable)==expected


def test_windows_command_roots_do_not_copy_ambient_path():
    from jan_mcp_commander.environment import _command_directories
    values={'SystemRoot':r'C:\Windows','ProgramFiles':r'C:\Program Files','LOCALAPPDATA':r'C:\Users\test\Local','PATH':r'.;C:\attacker'}
    result=_command_directories('win32',values,r'C:\pcrc\runtime\python.exe')
    assert r'C:\Program Files\nodejs' in result
    assert r'C:\Program Files\Git\cmd' in result
    assert r'C:\Users\test\Local\PCRemoteCommander\bootstrap\bin' in result
    assert '.' not in result and not any('attacker' in item for item in result)


def test_command_path_denies_relative_and_symlinked_candidate_roots(tmp_path,monkeypatch):
    from jan_mcp_commander import environment
    real=tmp_path/'real';real.mkdir()
    linked=tmp_path/'linked'
    try:linked.symlink_to(real,target_is_directory=True)
    except OSError:linked=None
    candidates=['.',str(real),str(real),str(linked/'nested') if linked else './nested']
    if linked:(real/'nested').mkdir()
    monkeypatch.setattr(environment,'_command_directories',lambda *args:candidates)
    assert environment.command_path()==str(real)


def test_runtime_parser_environment_does_not_gain_command_path(monkeypatch):
    from jan_mcp_commander.environment import runtime_environment
    monkeypatch.setenv('PATH',r'C:\attacker')
    monkeypatch.setenv('SYNTHETIC_API_TOKEN','private')
    result=runtime_environment()
    assert not any(key.upper()=='PATH' for key in result)
    assert 'SYNTHETIC_API_TOKEN' not in result
