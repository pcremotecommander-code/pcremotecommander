"""Regression coverage for the real Windows acceptance report, using synthetic files."""
import json
import os
import sys
import time
from pathlib import Path
import pytest
from jan_mcp_commander.control import ControlCommander
from jan_mcp_commander.errors import public_error


@pytest.fixture
def commander(tmp_path, monkeypatch):
    root = tmp_path / 'workspace'
    root.mkdir()
    monkeypatch.setenv('JAN_MCP_STATE_DIR',str(tmp_path/'state'))
    control = ControlCommander(root, enabled={'files', 'commands'})
    yield control
    control.close_control()


def test_directory_separators_and_containment(commander):
    folder = commander.workspace/'test folder'/'nested'
    folder.mkdir(parents=True)
    (folder/'sample.txt').write_text('synthetic')
    paths = ['test folder/nested', 'test folder/nested/']
    if os.name == 'nt': paths += ['test folder\\nested', 'test folder\\nested\\']
    for path in paths:
        assert commander.list_files(path)['entries'] == [{'name':'sample.txt','kind':'file'}]
    for path in ['../', '/', 'test folder/../../', '.ssh/', 'C:/Windows/']:
        with pytest.raises(ValueError): commander.list_files(path)


def test_missing_paths_and_hash_mismatch_are_actionable_without_path_leaks(commander):
    def failure(fn):
        with pytest.raises(Exception) as caught: fn()
        result = public_error(caught.value)
        assert str(commander.workspace) not in json.dumps(result)
        return result['error_code']
    assert failure(lambda: commander.file_info('missing.txt')) == 'FILE_NOT_FOUND'
    assert failure(lambda: commander.list_files('missing/')) == 'FILE_NOT_FOUND'
    assert failure(lambda: commander.write_text('missing/new.txt','test')) == 'PARENT_DIRECTORY_NOT_FOUND'
    commander.write_text('sample.txt','before')
    assert failure(lambda: commander.edit_text('sample.txt','before','after','0'*64,False)) == 'HASH_MISMATCH'
    assert failure(lambda: commander.delete_text('sample.txt','0'*64)) == 'HASH_MISMATCH'
    assert failure(lambda: commander.move_text('sample.txt','other.txt','0'*64)) == 'HASH_MISMATCH'
    assert commander.read_text('sample.txt')['content'] == 'before'
    assert failure(lambda: commander.list_files('../')) == 'INVALID_PATH'
    assert failure(lambda: commander.list_files('.ssh/')) == 'PATH_POLICY_DENIED'


def test_symlink_directory_remains_blocked(commander, tmp_path):
    outside = tmp_path/'outside'
    outside.mkdir()
    link = commander.workspace/'link'
    try: link.symlink_to(outside, target_is_directory=True)
    except OSError as error:
        if getattr(error,'winerror',None) == 1314: pytest.skip('Windows symlink privilege unavailable')
        raise
    with pytest.raises(ValueError): commander.list_files('link/')


def test_owned_process_input_output_and_stop(commander):
    script = 'import sys,time; print("READY",flush=True); value=input(); print("ECHO:"+value,flush=True); time.sleep(20)'
    session = commander.start_program(sys.executable,['-u','-c',script],timeout_seconds=30)['session_id']
    try:
        commander.process_input(session,'PCRC_TEST_INPUT')
        deadline = time.monotonic()+5
        while time.monotonic() < deadline:
            output = commander.process_output(session)
            if 'ECHO:PCRC_TEST_INPUT' in output['output']: break
            time.sleep(0.05)
        assert 'ECHO:PCRC_TEST_INPUT' in output['output']
        assert output['running']
        with pytest.raises(ValueError): commander.process_input('not-owned','test')
    finally: commander.stop_session(session)
    assert session not in commander._sessions


def test_synchronous_command_does_not_advertise_a_retained_session(commander):
    result = commander.run_command('echo PCRC_SESSION_TEST', shell='cmd' if os.name=='nt' else 'system')
    assert result['session_retained'] is False
    assert 'PCRC_SESSION_TEST' in result['output']
    with pytest.raises(Exception) as caught: commander.process_output(result['session_id'])
    assert public_error(caught.value)['error_code'] == 'UNKNOWN_SESSION'
