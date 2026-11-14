"""Check the bundled native executable without starting any public tunnel."""
import hashlib
import json
import os
from pathlib import Path
import platform
import subprocess
import tempfile
from jan_mcp_commander import cloudflare as cf
from jan_mcp_commander.http_server import prepare_backend


def main():
    with tempfile.TemporaryDirectory(prefix='jan-tunnel-verify-') as folder:
        root=Path(folder);work=root/'synthetic-workspace';work.mkdir()
        previous=os.environ.get('JAN_MCP_STATE_DIR');os.environ['JAN_MCP_STATE_DIR']=str(root/'private-state')
        try:commander,_,_=prepare_backend(work,initialize=True)
        finally:
            if previous is None:os.environ.pop('JAN_MCP_STATE_DIR',None)
            else:os.environ['JAN_MCP_STATE_DIR']=previous
        runtime=cf.runtime_directory(commander)
        binary=cf.binary(runtime,download=True)
        env=dict(cf.clean_environment(),HOME=str(runtime),USERPROFILE=str(runtime))
        outputs=[]
        for arguments in ([str(binary),'--version'],cf.command(binary,8866)+['--help']):
            result=subprocess.run(arguments,env=env,cwd=runtime,capture_output=True,text=True,timeout=15,check=True)
            outputs.append(result.stdout+result.stderr)
        assert cf.VERSION in outputs[0]
        for option in ('--http-host-header','--no-autoupdate','--metrics','--management-diagnostics'):
            assert option in outputs[1], 'Required tunnel option missing: '+option
        print(json.dumps({'native_platform':platform.system()+' '+platform.machine(),'version':cf.VERSION,'sha256':hashlib.sha256(binary.read_bytes()).hexdigest(),'native_version_and_help_verified':True,'private_install_verified':True,'public_tunnel_started':False,'production_ready':False}))

if __name__=='__main__':main()
