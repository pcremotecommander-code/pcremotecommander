"""Fail-closed Windows media preflight using the OS antimalware interface."""
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
from .environment import runtime_environment
from .worker_limits import remaining


def scan_bytes(data, suffix='.bin', *, deadline=None):
    if os.name != 'nt':
        raise ValueError('Verified Windows malware scanning is required for this media release')
    if not isinstance(data, bytes) or len(data) > 160 * 1024 * 1024 or suffix not in {'.bin','.pdf','.zip','.whl','.tgz','.png','.wav','.docx','.xlsx'}:
        raise ValueError('Invalid security scan input')
    powershell = Path(os.environ.get('SystemRoot', r'C:\Windows'))/'System32/WindowsPowerShell/v1.0/powershell.exe'
    try:
        status = subprocess.run([str(powershell), '-NoProfile', '-NonInteractive', '-Command',
            'Get-MpComputerStatus | Select-Object AMServiceEnabled,AntivirusEnabled,RealTimeProtectionEnabled,AntivirusSignatureAge | ConvertTo-Json -Compress'],
            stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=remaining(deadline,15), env=runtime_environment(), creationflags=subprocess.CREATE_NO_WINDOW)
        if status.returncode or len(status.stdout) > 8192:
            raise ValueError('Scanner status could not be verified; operation stopped')
        value = json.loads(status.stdout.decode('utf-8-sig'))
        if (any(value.get(key) is not True for key in ['AMServiceEnabled','AntivirusEnabled','RealTimeProtectionEnabled']) or
                type(value.get('AntivirusSignatureAge')) is not int or not 0<=value['AntivirusSignatureAge']<=7):
            raise ValueError('Defender must be active with current signatures; operation stopped')
        result = subprocess.run([sys.executable, '-I', str(Path(__file__).with_name('_security_scan_worker.py')), suffix],
            input=data, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=remaining(deadline,30),
            env=runtime_environment(), creationflags=subprocess.CREATE_NO_WINDOW)
        if result.returncode or len(result.stdout) > 1024:
            raise ValueError('Malware scan failed; operation stopped')
        verdict = json.loads(result.stdout)
        if verdict.get('hresult') != 0 or type(verdict.get('result')) is not int or verdict['result'] not in {0,1}:
            raise ValueError('Threat, policy block or scan error; operation stopped')
    except (OSError, subprocess.TimeoutExpired, json.JSONDecodeError) as exc:
        raise ValueError('Security scan unavailable or timed out; operation stopped') from exc
    return {'scanner':'Windows AMSI with active Defender','result':'no_detection','sha256':hashlib.sha256(data).hexdigest()}
