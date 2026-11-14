"""Application metadata is not a shell command or a grant to control user windows."""
import os
import sys
from types import SimpleNamespace
from unittest.mock import Mock
import pytest
from jan_mcp_commander.applications import ApplicationError, _native_applications, installed_applications, launch_application, select_application
from jan_mcp_commander.control import ControlCommander
from jan_mcp_commander.errors import public_error

ROWS=[{'name':'Microsoft Excel','app_id':'Vendor.Excel!App'}, {'name':'Chrome','app_id':'Vendor.Chrome'}, {'name':'Chrome Beta','app_id':'Vendor.ChromeBeta'}]


def test_native_catalog_and_launch_targets(tmp_path, monkeypatch):
    desktop = tmp_path / 'editor.desktop'
    desktop.write_text('[Desktop Entry]\nName=Editor\nType=Application\nExec=editor %F\n', encoding='utf-8')
    (tmp_path / 'hidden.desktop').write_text('[Desktop Entry]\nName=Hidden\nType=Application\nNoDisplay=true\n', encoding='utf-8')
    bundle = tmp_path / 'Sample.app'
    (bundle / 'Contents').mkdir(parents=True)
    (bundle / 'Contents' / 'Info.plist').touch()
    assert _native_applications([tmp_path], '.desktop') == [{'name': 'Editor', 'app_id': str(desktop)}]
    assert _native_applications([tmp_path], '.app') == [{'name': 'Sample', 'app_id': str(bundle)}]
    run = Mock()
    monkeypatch.setattr('jan_mcp_commander.applications.subprocess.run', run)
    monkeypatch.setenv('PCRC_TEST_SECRET', 'private')
    for platform, target, expected in [('linux', desktop, ['/usr/bin/gio', 'launch']), ('darwin', bundle, ['/usr/bin/open', '-a'])]:
        monkeypatch.setattr(sys, 'platform', platform)
        launch_application(str(target))
        assert run.call_args.args[0] == expected + [str(target)]
        assert run.call_args.kwargs['shell'] is False
        assert 'PCRC_TEST_SECRET' not in run.call_args.kwargs['env']


def test_selection_uses_exact_id_or_unambiguous_name_and_rejects_missing_apps():
    assert select_application(ROWS,'excel')['app_id']=='Vendor.Excel!App'
    assert select_application(ROWS,'Chrome')['app_id']=='Vendor.Chrome'
    assert select_application(ROWS,'Vendor.ChromeBeta')['name']=='Chrome Beta'
    with pytest.raises(ApplicationError) as error:select_application(ROWS,'Chr')
    assert public_error(error.value)['error_code']=='APPLICATION_AMBIGUOUS'
    with pytest.raises(ApplicationError) as error:select_application(ROWS,'private-nonexistent-app')
    assert public_error(error.value)['error_code']=='APPLICATION_NOT_FOUND'
    assert 'private-nonexistent' not in str(public_error(error.value))


@pytest.mark.skipif(os.name!='nt',reason='Windows Start-menu discovery')
def test_discovery_is_fixed_script_no_user_query_or_shell(monkeypatch):
    run=Mock(return_value=SimpleNamespace(returncode=0,stdout='[{"Name":"Excel","AppID":"Vendor.Excel!App"}]'))
    monkeypatch.setattr('jan_mcp_commander.applications.subprocess.run',run)
    assert installed_applications()==[{'name':'Excel','app_id':'Vendor.Excel!App'}]
    args,kwargs=run.call_args
    assert 'Get-StartApps' in args[0][-1]
    assert kwargs['shell'] is False and kwargs['timeout']==15
    assert 'PATH' not in kwargs['env']
    run.return_value.stdout='not json'
    with pytest.raises(ApplicationError):installed_applications()


@pytest.mark.skipif(os.name!='nt',reason='Windows Start-menu launch')
def test_launch_is_catalog_bound_and_requires_commands_capability(tmp_path,monkeypatch):
    monkeypatch.setenv('JAN_MCP_STATE_DIR',str(tmp_path/'private'))
    monkeypatch.setattr('jan_mcp_commander.applications.installed_applications',lambda:ROWS)
    launch=Mock();monkeypatch.setattr(os,'startfile',launch)
    work=tmp_path/'work';work.mkdir()
    pc=ControlCommander(work,enabled={'commands'})
    try:
        result=pc.list_applications('chrome',1)
        assert len(result['applications'])==1 and result['truncated']
        result=pc.open_application('excel')
        launch.assert_called_once_with('shell:AppsFolder\\Vendor.Excel!App')
        assert result['launch_requested'] is True and result['visible_verified'] is False
        for bad in ['Chr','https://example.com','excel\x00']:
            with pytest.raises(ValueError):pc.open_application(bad)
        assert launch.call_count==1
        pc.enabled=frozenset()
        with pytest.raises(ValueError):pc.open_application('excel')
        assert launch.call_count==1
    finally:pc.close_control()
