"""Real TCP/MCP smoke test using an isolated synthetic workspace and private state."""
import json
import os
from pathlib import Path
import socket
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
from jan_mcp_commander.cloudflare import clean_environment, spawn, stop
from jan_mcp_commander.http_server import prepare_backend


def main():
    with tempfile.TemporaryDirectory(prefix='jan-http-verify-') as folder:
        root=Path(folder);work=root/'workspace';work.mkdir();(work/'hello.txt').write_text('JAN HTTP verification')
        state=root/'state';prior=os.environ.get('JAN_MCP_STATE_DIR');os.environ['JAN_MCP_STATE_DIR']=str(state)
        try:_,token,_=prepare_backend(work,initialize=True)
        finally:
            if prior is None:os.environ.pop('JAN_MCP_STATE_DIR',None)
            else:os.environ['JAN_MCP_STATE_DIR']=prior
        with socket.socket() as sock:sock.bind(('127.0.0.1',0));port=sock.getsockname()[1]
        env=clean_environment();env['JAN_MCP_STATE_DIR']=str(state);env['JAN_MCP_ALLOW_WRITES']='1'
        child=spawn([sys.executable,'-I','-m','jan_mcp_commander.http_server','--workspace',str(work),'--port',str(port)],env)
        opener=urllib.request.build_opener(urllib.request.ProxyHandler({}))
        def request(method,params=None,key=token):
            body={'jsonrpc':'2.0','id':1,'method':method}
            if params is not None:body['params']=params
            req=urllib.request.Request(f'http://127.0.0.1:{port}/mcp',data=json.dumps(body).encode(),headers={'Authorization':'Bearer '+key,'Content-Type':'application/json','Accept':'application/json, text/event-stream'})
            with opener.open(req,timeout=5) as res:return json.load(res)
        try:
            for _ in range(60):
                if child.poll() is not None:raise RuntimeError('HTTP child exited')
                try:
                    init=request('initialize',{'protocolVersion':'2025-11-25','capabilities':{},'clientInfo':{'name':'JAN TCP verifier','version':'1'}});break
                except (OSError,urllib.error.URLError):time.sleep(.2)
            else:raise RuntimeError('HTTP did not become ready')
            tools=request('tools/list')['result']['tools'];assert len(tools)==13
            read=request('tools/call',{'name':'jan_read_text','arguments':{'path':'hello.txt'}})
            assert 'JAN HTTP verification' in json.dumps(read)
            denied=request('tools/call',{'name':'jan_write_text','arguments':{'path':'denied.txt','content':'blocked'}})
            assert denied['result']['isError'] and not (work/'denied.txt').exists()
            try:request('tools/list',key='B'*43)
            except urllib.error.HTTPError as exc:assert exc.code==401
            else:raise AssertionError('Bad key accepted')
        finally:stop(child)
        print(json.dumps({'tcp_http_verified':True,'tools':len(tools),'read_verified':True,'remote_write_denied':True,'invalid_key_denied':True,'owned_process_stopped':child.poll() is not None,'cloudflare_live_verified':False}))

if __name__=='__main__':main()
