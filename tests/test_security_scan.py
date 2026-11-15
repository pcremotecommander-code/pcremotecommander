import json
from types import SimpleNamespace

import pytest

from jan_mcp_commander import security_scan
from jan_mcp_commander.environment import runtime_environment


@pytest.mark.skipif(security_scan.os.name != 'nt', reason='Windows scanner integration')
@pytest.mark.parametrize('suffix',['.docx','.xlsx'])
def test_office_suffixes_reach_verified_defender_and_exact_byte_scan(monkeypatch,suffix):
    calls=[]
    def run(argv,**kwargs):
        calls.append((argv,kwargs))
        value={'AMServiceEnabled':True,'AntivirusEnabled':True,'RealTimeProtectionEnabled':True,'AntivirusSignatureAge':0} if len(calls)==1 else {'hresult':0,'result':0}
        return SimpleNamespace(returncode=0,stdout=json.dumps(value).encode())
    monkeypatch.setattr(security_scan.subprocess,'run',run)
    result=security_scan.scan_bytes(b'PK synthetic Office bytes',suffix)
    assert result['result']=='no_detection'
    assert len(calls)==2
    assert calls[1][0][-1]==suffix
    assert calls[1][1]['input']==b'PK synthetic Office bytes'


def test_system_drive_for_native_provider_does_not_inherit_application_secrets(monkeypatch):
    monkeypatch.setenv('SystemDrive', 'C:')
    monkeypatch.setenv('PCRC_TEST_API_SECRET', 'synthetic-secret')
    assert {k.upper():v for k,v in runtime_environment().items()}['SYSTEMDRIVE'] == 'C:'
    assert 'PCRC_TEST_API_SECRET' not in runtime_environment()


@pytest.mark.skipif(security_scan.os.name!='nt',reason='Windows runtime environment')
def test_older_parent_recovers_system_drive_from_windows_directory(monkeypatch):
    monkeypatch.delenv('SystemDrive',raising=False)
    monkeypatch.setenv('SystemRoot',r'D:\Windows')
    assert {k.upper():v for k,v in runtime_environment().items()}['SYSTEMDRIVE']=='D:'


@pytest.mark.skipif(security_scan.os.name != 'nt', reason='Windows scanner deadline contract')
def test_scan_uses_one_shared_deadline_instead_of_stacking_timeouts(monkeypatch):
    import jan_mcp_commander.worker_limits as limits
    clock=[0];timeouts=[]
    monkeypatch.setattr(limits.time,'monotonic',lambda:clock[0])
    def run(*args,**kwargs):
        timeouts.append(kwargs['timeout'])
        if len(timeouts)==1:
            clock[0]=14
            return SimpleNamespace(returncode=0,stdout=json.dumps({'AMServiceEnabled':True,'AntivirusEnabled':True,'RealTimeProtectionEnabled':True,'AntivirusSignatureAge':0}).encode())
        return SimpleNamespace(returncode=0,stdout=b'{"hresult":0,"result":0}')
    monkeypatch.setattr(security_scan.subprocess,'run',run)
    security_scan.scan_bytes(b'synthetic',deadline=15)
    assert timeouts==[15,1]


@pytest.mark.skipif(security_scan.os.name != 'nt', reason='Windows scanner integration')
@pytest.mark.parametrize('verdict', [0, 1, 2, 16384, 32768])
def test_scan_only_accepts_completed_no_detection(monkeypatch, verdict):
    calls=[]
    def run(argv, **kwargs):
        calls.append((argv, kwargs))
        result = {'AMServiceEnabled':True,'AntivirusEnabled':True,'RealTimeProtectionEnabled':True,'AntivirusSignatureAge':0} if len(calls)==1 else {'hresult':0,'result':verdict}
        return SimpleNamespace(returncode=0, stdout=json.dumps(result).encode())
    monkeypatch.setattr(security_scan.subprocess, 'run', run)
    if verdict in {0,1}:
        assert security_scan.scan_bytes(b'fixture')['result']=='no_detection'
    else:
        with pytest.raises(ValueError, match='operation stopped'):security_scan.scan_bytes(b'fixture')
    assert calls[1][1]['input']==b'fixture'
    assert calls[1][1]['timeout']==30


@pytest.mark.skipif(security_scan.os.name != 'nt', reason='Windows scanner integration')
def test_missing_protection_and_scan_errors_never_pass(monkeypatch):
    monkeypatch.setattr(security_scan.subprocess,'run',lambda *a,**k:SimpleNamespace(returncode=0,stdout=b'{}'))
    with pytest.raises(ValueError): security_scan.scan_bytes(b'fixture')
    def timeout(*args, **kwargs):raise security_scan.subprocess.TimeoutExpired(args[0], 15)
    monkeypatch.setattr(security_scan.subprocess,'run',timeout)
    with pytest.raises(ValueError,match='timed out'):security_scan.scan_bytes(b'fixture')
