import importlib.util
import json
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('public_gates', ROOT / 'scripts/check_public_release_gates.py')
gates = importlib.util.module_from_spec(spec)
spec.loader.exec_module(gates)


def test_public_release_gates_fail_closed(tmp_path):
    path = tmp_path / 'status.json'
    path.write_text(json.dumps({'public_multiuser': {'gates': {}}}))
    assert gates.check(path) == sorted(gates.REQUIRED)
    path.write_text(json.dumps({'public_multiuser': {'gates': {
        name: {'passed': True, 'evidence': 'synthetic fixture'} for name in gates.REQUIRED}}}))
    assert gates.check(path) == []
    path.write_text(json.dumps({'public_multiuser': {'gates': {
        name: {'passed': True} for name in gates.REQUIRED}}}))
    assert gates.check(path) == sorted(gates.REQUIRED)


def test_checked_in_public_release_is_blocked():
    blocked = gates.check(ROOT / 'docs/release-status.json')
    assert blocked == sorted(gates.REQUIRED)
