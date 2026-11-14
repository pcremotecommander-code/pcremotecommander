"""Narrow OS-runtime variables, never arbitrary ambient application secrets."""
from itertools import islice
import ntpath
import os
from pathlib import Path
import posixpath
import re
import sys

WINDOWS_RUNTIME = {'SYSTEMROOT','SYSTEMDRIVE','WINDIR','USERPROFILE','LOCALAPPDATA','APPDATA','TEMP','TMP',
                   'PROGRAMFILES','PROGRAMFILES(X86)','PROGRAMW6432','COMMONPROGRAMFILES','COMMONPROGRAMFILES(X86)'}

def runtime_environment():
    env = {k:v for k,v in os.environ.items() if k.upper() in WINDOWS_RUNTIME}
    if os.name == 'nt':
        if not any(k.upper()=='SYSTEMDRIVE' for k in env):
            # Older PCRC parents omitted this non-secret variable required by AMSI.
            env['SystemDrive']=os.path.splitdrive(os.environ.get('SystemRoot',r'C:\Windows'))[0]
        env['PATHEXT'] = '.COM;.EXE;.BAT;.CMD'
        env['ComSpec'] = os.path.join(os.environ.get('SystemRoot', r'C:\Windows'), 'System32', 'cmd.exe')
    return env


def _command_directories(platform, env, executable):
    """Known installation roots only; ambient PATH and command cwd never select tools."""
    if platform == 'win32':
        values={key.upper():value for key,value in env.items()}
        join=ntpath.join
        candidates=[join(values.get('SYSTEMROOT',r'C:\Windows'),'System32'),ntpath.dirname(executable)]
        for name in ('PROGRAMW6432','PROGRAMFILES','PROGRAMFILES(X86)'):
            if root:=values.get(name):
                candidates.extend([join(root,'nodejs'),join(root,'Git','cmd')])
        if local:=values.get('LOCALAPPDATA'):
            candidates.extend([join(local,'PCRemoteCommander','bootstrap','bin'),join(local,'Programs','nodejs'),
                               join(local,'Programs','Git','cmd')])
        return candidates
    return ['/usr/bin','/bin',posixpath.dirname(executable),'/usr/local/bin',*(['/opt/homebrew/bin'] if platform=='darwin' else [])]


def command_path():
    """Approved commands can find installed runtimes without inheriting application secrets."""
    candidates=_command_directories(sys.platform,os.environ,sys.executable)
    if os.name != 'nt':
        # Only PCRC's bounded user-runtime root is inspected, never arbitrary PATH entries.
        tools=Path.home()/'.pcrc'/'tools'
        if tools.is_dir() and not any(p.is_symlink() for p in [tools,*tools.parents]):
            entries=list(islice(tools.iterdir(),33))
            for item in sorted(entries,reverse=True) if len(entries)<=32 else []:
                if re.fullmatch(r'node-v[0-9]+\.[0-9]+\.[0-9]+-(?:linux|darwin)-(?:x64|arm64)',item.name):
                    if (item/'bin'/'node').is_file():candidates.append(str(item/'bin'))
    selected=[]
    seen=set()
    for value in candidates:
        path=Path(value)
        key=os.path.normcase(value)
        if (not path.is_absolute() or key in seen or not path.is_dir()
                or any(p.is_symlink() for p in [path,*path.parents])):
            continue
        selected.append(str(path));seen.add(key)
    return os.pathsep.join(selected)
