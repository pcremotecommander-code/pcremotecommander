"""Source scanning catches committed secrets without disclosing their values."""
import importlib.util
from pathlib import Path
import subprocess

import pytest

spec = importlib.util.spec_from_file_location('source_credentials', Path(__file__).resolve().parents[1] / 'scripts/check_source_credentials.py')
scanner = importlib.util.module_from_spec(spec)
spec.loader.exec_module(scanner)


@pytest.fixture
def repository(tmp_path):
    subprocess.run(['git', 'init', '-q', str(tmp_path)], check=True)
    return tmp_path


def test_credentials_and_private_state_are_reported_without_values(repository):
    secret = 'npm_' + 'A' * 36
    (repository / 'source.txt').write_text(secret)
    (repository / '.env').write_text('private')
    (repository / '.gitignore').write_text('.env\n')
    subprocess.run(['git', 'add', '-f', '.env'], cwd=repository, check=True)
    results = scanner.scan(repository)
    assert ('source.txt', 'credential pattern') in results
    assert ('.env', 'private-state path') in results
    assert secret not in repr(results)


def test_ignored_private_files_and_benign_examples(repository):
    (repository / '.gitignore').write_text('.env\n')
    (repository / '.env').write_text('npm_' + 'A' * 36)
    (repository / '.env.example').write_text('TOKEN=replace-me\n')
    assert scanner.scan(repository) == []


def test_cli_redacts_credentials_in_filenames(repository, capsys):
    secret = 'npm_' + 'A' * 36
    (repository / ('.env.' + secret)).write_text('private')
    assert scanner.main(repository) == 1
    output = capsys.readouterr().out
    assert secret not in output and '[redacted]' in output


def test_oversized_source_is_rejected(repository, monkeypatch):
    monkeypatch.setattr(scanner, 'LIMIT', 8)
    (repository / 'large.txt').write_text('x' * 9)
    assert scanner.scan(repository) == [('large.txt', 'missing or oversized source')]


def test_linked_source_is_not_read(repository, tmp_path_factory):
    external = tmp_path_factory.mktemp('outside') / 'secret.txt'
    external.write_text('private')
    try:
        (repository / 'linked.txt').symlink_to(external)
    except OSError:
        pytest.skip('Creating symlinks requires Windows privileges')
    assert scanner.scan(repository) == [('linked.txt', 'linked source path')]


def test_ci_has_no_production_credentials_or_privileged_triggers():
    import yaml
    workflow = Path(__file__).resolve().parents[1] / '.github/workflows/source-checks.yml'
    raw = workflow.read_text()
    config = yaml.load(raw, Loader=yaml.BaseLoader)
    assert set(config['on']) == {'push', 'pull_request', 'workflow_dispatch'}
    assert config['permissions'] == {'contents': 'read'}
    assert 'secrets.' not in raw and 'self-hosted' not in raw
    for job in config['jobs'].values():
        assert 'permissions' not in job and 'environment' not in job
        for step in job['steps']:
            if 'uses' in step:
                import re
                assert re.fullmatch(r'actions/[a-z-]+@[0-9a-f]{40}', step['uses'])
                if step['uses'].startswith('actions/checkout@'):
                    assert step['with']['persist-credentials'] == 'false'
