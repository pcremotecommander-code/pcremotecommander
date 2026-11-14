"""Native application metadata and exact approved launch targets."""
import configparser
import json
import os
from pathlib import Path
import subprocess
import sys

class ApplicationError(ValueError):
    def __init__(self, code, message):
        super().__init__(message)
        self.code=code


def _desktop_name(entry):
    config = configparser.ConfigParser(interpolation=None, strict=False)
    try:
        with entry.open(encoding='utf-8') as stream:
            data = stream.read(65537)
        if len(data) > 65536:
            return None
        config.read_string(data)
        app = config['Desktop Entry']
        if app.get('Type') == 'Application' and not any(app.getboolean(key, False) for key in ('Hidden', 'NoDisplay')):
            return app.get('Name')
    except (OSError, ValueError, KeyError, configparser.Error):
        return None


def _native_applications(roots, suffix):
    rows = []
    for root in roots:
        for entry in sorted(root.glob('*' + suffix)):
            target = str(entry)
            if entry.is_symlink() or len(target) > 512 or any(c in target for c in '\x00\r\n'):
                continue
            if suffix == '.app':
                name = entry.stem if (entry / 'Contents' / 'Info.plist').is_file() else None
            else:
                name = _desktop_name(entry) if entry.is_file() else None
            if name and len(name) <= 200 and not any(c in name for c in '\x00\r\n'):
                rows.append({'name': name, 'app_id': target})
                if len(rows) == 2048:
                    return rows
    return rows


def installed_applications():
    if sys.platform == 'darwin':
        return _native_applications((Path('/Applications'), Path('/System/Applications'),
                                     Path('/System/Applications/Utilities'), Path.home() / 'Applications'), '.app')
    if sys.platform.startswith('linux'):
        user_data = Path(os.environ.get('XDG_DATA_HOME', ''))
        if not user_data.is_absolute():
            user_data = Path.home() / '.local/share'
        return _native_applications((user_data / 'applications', Path('/usr/local/share/applications'),
                                     Path('/usr/share/applications')), '.desktop')
    if os.name != 'nt':
        raise ApplicationError('PLATFORM_UNSUPPORTED','Application discovery is unavailable on this OS. Use start_program with an approved absolute executable.')
    executable=Path(os.environ.get('SystemRoot',r'C:\Windows'))/'System32/WindowsPowerShell/v1.0/powershell.exe'
    script="[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false); @(Get-StartApps | Sort-Object Name | Select-Object Name,AppID) | ConvertTo-Json -Compress"
    from .environment import runtime_environment
    result=subprocess.run([str(executable),'-NoLogo','-NoProfile','-NonInteractive','-Command',script],
                          capture_output=True,text=True,encoding='utf-8',errors='replace',timeout=15,env=runtime_environment(),shell=False)
    if result.returncode or len(result.stdout.encode())>524288:
        raise ApplicationError('APPLICATION_DISCOVERY_FAILED','Windows application discovery failed. Use start_program with a known absolute executable; do not install anything automatically.')
    try:
        rows=json.loads(result.stdout.lstrip('\ufeff')) if result.stdout.strip() else []
    except ValueError:
        raise ApplicationError('APPLICATION_DISCOVERY_FAILED','Windows returned invalid application metadata. Use start_program with an approved absolute executable.') from None
    if isinstance(rows,dict):rows=[rows]
    if not isinstance(rows,list):
        raise ApplicationError('APPLICATION_DISCOVERY_FAILED','Windows returned invalid application metadata. Retry list_applications.')
    return [{'name':row['Name'],'app_id':row['AppID']} for row in rows[:2048] if isinstance(row,dict)
            and isinstance(row.get('Name'),str) and 0<len(row['Name'])<=200
            and isinstance(row.get('AppID'),str) and 0<len(row['AppID'])<=512
            and not any(c in row['AppID'] for c in '\x00\r\n')]


def launch_application(app_id):
    if sys.platform == 'win32':
        os.startfile('shell:AppsFolder\\' + app_id)
        return
    argv = ['/usr/bin/open', '-a', app_id] if sys.platform == 'darwin' else ['/usr/bin/gio', 'launch', app_id]
    session_keys = {'HOME', 'DISPLAY', 'WAYLAND_DISPLAY', 'XDG_RUNTIME_DIR', 'DBUS_SESSION_BUS_ADDRESS', 'XAUTHORITY'}
    env = {key: value for key, value in os.environ.items() if key in session_keys}
    env['PATH'] = '/usr/bin:/bin'
    try:
        subprocess.run(argv, env=env, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                       stderr=subprocess.DEVNULL, timeout=15, check=True, shell=False)
    except (OSError, subprocess.SubprocessError) as exc:
        raise ApplicationError('APPLICATION_LAUNCH_FAILED', 'Could not launch the app in the current desktop session. On Linux, verify that GIO is installed.') from exc


def validate_query(query, empty=False):
    if not isinstance(query,str) or len(query)>512 or any(c in query for c in '\x00\r\n') or (not empty and not query.strip()):
        raise ValueError('Use a bounded application name or ID without control characters')
    return query.strip().casefold()


def select_application(rows, query):
    query=validate_query(query)
    matches=[row for row in rows if row['app_id'].casefold()==query or row['name'].casefold()==query]
    if not matches:matches=[row for row in rows if query in row['name'].casefold()]
    if not matches:
        raise ApplicationError('APPLICATION_NOT_FOUND','No installed app matched. Call list_applications with a shorter name, or use start_program with its approved absolute executable. Portable apps may not be registered.')
    if len(matches)!=1:
        raise ApplicationError('APPLICATION_AMBIGUOUS','Multiple installed apps match. Call list_applications and retry open_application with one exact app_id.')
    return matches[0]
