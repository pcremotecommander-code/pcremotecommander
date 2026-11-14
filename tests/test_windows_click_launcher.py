import os
from pathlib import Path
import subprocess
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import threading

import pytest

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / 'deploy/cloudflare/worker/public/install'


def test_single_file_launcher_uses_canonical_installer():
    command = (SOURCE / 'Start-PCRC.cmd').read_text()
    assert 'https://pc-remote-commander.pcremotecommander.workers.dev/install.ps1' in command
    assert 'ExecutionPolicy' not in command
    assert '--enroll' not in command
    assert 'exit /b %PCRC_EXIT%' in command
    assert not (SOURCE / 'PC-Remote-Commander-Windows.zip').exists()


@pytest.mark.skipif(os.name != 'nt', reason='Windows batch execution')
@pytest.mark.parametrize('exit_code', [0, 7])
def test_double_click_launcher_starts_once_and_preserves_failure(tmp_path, exit_code):
    requests = []

    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            requests.append(self.path)
            self.send_response(200)
            self.send_header('Content-Type', 'text/plain; charset=utf-8')
            self.end_headers()
            self.wfile.write(f"Write-Output 'PCRC_SYNTHETIC_LAUNCH'; exit {exit_code}".encode())

        def log_message(self, *_):
            pass

    server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    folder = tmp_path / 'download folder with spaces'
    folder.mkdir()
    command = (SOURCE / 'Start-PCRC.cmd').read_text().replace(
        'https://pc-remote-commander.pcremotecommander.workers.dev/install.ps1',
        f'http://127.0.0.1:{server.server_port}/synthetic.ps1')
    launcher = folder / 'Start-PCRC.cmd'
    launcher.write_text(command)
    try:
        result = subprocess.run(['cmd.exe', '/d', '/c', 'call', str(launcher)], input='\r\n',
                                capture_output=True, text=True, timeout=30)
        assert result.returncode == exit_code, result.stdout + result.stderr
        assert result.stdout.count('PCRC_SYNTHETIC_LAUNCH') == 1
        assert requests == ['/synthetic.ps1']
    finally:
        server.shutdown()
        server.server_close()
