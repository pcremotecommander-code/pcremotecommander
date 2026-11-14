import importlib.util
from pathlib import Path
import pytest
import yaml

ROOT = Path(__file__).resolve().parents[1]

def module(name):
    spec = importlib.util.spec_from_file_location(name, ROOT / 'deploy/cloud' / (name + '.py'))
    result = importlib.util.module_from_spec(spec); spec.loader.exec_module(result)
    return result

def test_cloud_rejects_root_missing_id_and_writes(tmp_path):
    entry = module('entrypoint')
    key = tmp_path / 'secret'; key.write_text('synthetic-only')
    env = {'JAN_TUNNEL_ID': 'tunnel_' + 'a' * 32}
    assert entry.validate(env, 10001, key) == env['JAN_TUNNEL_ID']
    for bad_env, uid in [({}, 10001), (env, 0), (dict(env, JAN_MCP_ALLOW_WRITES='1'), 10001),
                          ({'JAN_TUNNEL_ID': 'tunnel_a;sh'}, 10001)]:
        with pytest.raises(ValueError):
            entry.validate(bad_env, uid, key)

def test_cloud_rejects_empty_secret(tmp_path):
    key = tmp_path / 'empty'; key.write_bytes(b'')
    with pytest.raises(ValueError):
        module('entrypoint').validate({'JAN_TUNNEL_ID': 'tunnel_'+'a'*32}, 10001, key)

def test_compose_has_no_public_ports_or_host_control():
    config = yaml.safe_load((ROOT / 'deploy/cloud/compose.yaml').read_text())
    service = config['services']['jan']
    assert not service.get('ports') and not service.get('privileged')
    assert service['read_only'] and service['user'] == '10001:10001'
    assert service['cap_drop'] == ['ALL']
    assert service['security_opt'] == ['no-new-privileges:true']
    assert service['volumes'][0]['read_only']
    assert service['pids_limit'] == 64 and service['mem_limit'] == '512m'
    assert 'docker.sock' not in str(config)

def test_download_rejects_tampered_archive(monkeypatch, tmp_path):
    import io
    installer = module('download_tunnel')
    monkeypatch.setattr(installer.urllib.request, 'urlopen', lambda *a, **k: io.BytesIO(b'tampered'))
    with pytest.raises(ValueError, match='checksum'):
        installer.install('amd64', tmp_path)
    assert not list(tmp_path.iterdir())

def test_production_gates_fail_closed(tmp_path):
    import json
    spec = importlib.util.spec_from_file_location('gates', ROOT / 'scripts/check_production_gates.py')
    gates = importlib.util.module_from_spec(spec); spec.loader.exec_module(gates)
    path = tmp_path / 'gates.json'
    path.write_text(json.dumps({'gates': {}}))
    assert gates.check(path) == sorted(gates.REQUIRED)
    path.write_text(json.dumps({'gates': {name:{'passed':True, 'evidence':'test fixture evidence'} for name in gates.REQUIRED}}))
    assert gates.check(path) == []
    path.write_text(json.dumps({'gates': {name:{'passed':True} for name in gates.REQUIRED}}))
    assert gates.check(path) == sorted(gates.REQUIRED)
