"""Validate prepared Oracle files without creating resources or touching a host."""
import json
from pathlib import Path
import subprocess
import yaml

ROOT = Path(__file__).resolve().parents[1]

def test_plan_is_pending_and_constrained_to_free_profile():
    plan = json.loads((ROOT / 'deploy/oracle/oracle-launch-plan.json').read_text())
    assert plan['status'] == 'prepared_not_launched'
    assert not plan['cloud_resources_created'] and not plan['account_connection_verified']
    assert plan['shape'] == 'VM.Standard.A1.Flex'
    assert plan['shape_config'] == {'ocpus': 2, 'memory_in_gbs': 12}
    assert plan['free_tier_checks']['verify_existing_A1_usage_before_launch']
    assert not plan['free_tier_checks']['paid_fallback_allowed']
    assert not plan['free_tier_checks']['account_upgrade_allowed']
    assert plan['boot_volume_gib'] == 50 and plan['new_instances'] == 1
    assert plan['network']['public_application_ports'] == []
    assert plan['network']['ssh_source_cidr'] == 'REPLACE_WITH_OPERATOR_PUBLIC_IP/32'
    assert not plan['activation']['automatically_start_JAN']

def test_bootstrap_prepares_host_without_starting_jan_or_adding_credentials(tmp_path):
    source = (ROOT / 'deploy/oracle/cloud-init.yaml').read_text()
    assert source.startswith('#cloud-config\n')
    config = yaml.safe_load(source)
    assert config['ssh_pwauth'] is False and config['disable_root'] is True
    assert 'users' not in config and 'ssh_authorized_keys' not in config
    assert config['package_update'] and config['package_upgrade']
    assert config['runcmd'] == [['bash', '/usr/local/sbin/jan-prepare-oracle']]
    script = config['write_files'][0]
    assert script['owner'] == 'root:root' and script['permissions'] == '0700'
    content = script['content']
    assert 'download.docker.com/linux/ubuntu' in content
    assert 'Signed-By: /etc/apt/keyrings/docker.asc' in content
    assert 'arm64' in content and '24.04' in content
    assert 'refusing to alter an existing deployment' in content
    assert 'usermod' not in content and 'compose up' not in content
    assert 'tunnel_api_key' not in content and 'tunnel-client' not in content
    if __import__('os').name == 'posix':
        path = tmp_path / 'bootstrap.sh'; path.write_text(content)
        subprocess.run(['bash', '-n', str(path)], check=True, capture_output=True, timeout=5)

def test_oracle_preparation_preserves_production_blockers():
    report = json.loads((ROOT / 'docs/release-status.json').read_text())
    assert not report['production_ready']
    assert not report['gates']['upstream_tunnel_findings_reviewed']['passed']
    assert not report['gates']['live_tunnel_authenticated']['passed']
