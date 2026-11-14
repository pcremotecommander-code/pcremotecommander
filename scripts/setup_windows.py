"""Windows setup without changing PowerShell execution policy."""
import argparse
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys


def main():
    parser=argparse.ArgumentParser(description='Set up PC Remote Commander on Windows')
    parser.add_argument('workspace',nargs='?')
    parser.add_argument('--skip-npm',action='store_true',help='Use Node dependencies already installed by the npx package')
    args=parser.parse_args()
    if sys.platform!='win32' or sys.version_info<(3,11):
        parser.exit(1,'Use Windows with a currently patched Python 3.11 or newer.\n')
    node=shutil.which('node.exe')
    npm=shutil.which('npm.cmd')
    if not node or not npm:
        parser.exit(1,'Node.js 20 or newer is required. Install it from nodejs.org, then run Setup-Windows.cmd again.\n')
    version=subprocess.run([node,'--version'],check=True,capture_output=True,text=True).stdout.strip()
    if not version.startswith('v') or not version[1:].split('.',1)[0].isdigit() or int(version[1:].split('.',1)[0])<20:
        parser.exit(1,'Node.js 20 or newer is required. Update Node.js and run Setup-Windows.cmd again.\n')
    root=Path(__file__).resolve().parents[1]
    configuration=root/'connection.json'
    prior=json.loads(configuration.read_text(encoding='utf-8-sig')) if configuration.exists() else {}
    selected=args.workspace or os.environ.get('JAN_MCP_WORKSPACE') or prior.get('workspace') or str(Path.home()/'PCRC-Workspace')
    workspace=Path(selected).expanduser();workspace.mkdir(parents=True,exist_ok=True)
    python=root/'.venv/Scripts/python.exe'
    if not python.is_file():
        subprocess.run([sys.executable,'-m','venv',str(root/'.venv')],cwd=root,check=True)
    subprocess.run([str(python),'-m','pip','install','--disable-pip-version-check','pip==26.2.1'],cwd=root,check=True)
    subprocess.run([str(python),'-m','pip','install','--disable-pip-version-check','-e',str(root)],cwd=root,check=True)
    prior['workspace']=str(workspace.resolve(strict=True))
    # Preserve unrelated connection options and do not put any secrets here.
    configuration.write_text(json.dumps(prior,indent=2),encoding='utf-8')
    subprocess.run([str(python),'scripts/verify_install.py'],cwd=root,check=True)
    if not args.skip_npm:
        subprocess.run([npm,'--prefix',str(root/'deploy/npm/jan-commander'),'ci','--omit=dev','--ignore-scripts','--no-audit','--no-fund'],cwd=root,check=True)
    print('PC Remote Commander installed. Start PC-Remote-Commander.cmd for staging; JAN-CLI.cmd remains available.')
    return 0

if __name__=='__main__':raise SystemExit(main())
