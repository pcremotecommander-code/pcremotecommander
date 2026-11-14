"""Exercise real file recovery and MCP protocol discovery in a temporary workspace."""
import json
import os
from pathlib import Path
import queue
import subprocess
import sys
import tempfile
import threading
from jan_mcp_commander.portable import PortableCommander


def verify():
    with tempfile.TemporaryDirectory(prefix='jan-verify-') as tmp:
        root = Path(tmp)
        work = root / 'workspace'
        work.mkdir()
        cmd = PortableCommander(work, root / 'audit.jsonl')
        cmd.allow_writes = True
        cmd.write_text('verify.txt', 'first')
        backup = cmd.write_text('verify.txt', 'second', overwrite=True)['backup_id']
        cmd.restore_backup(backup)
        assert cmd.read_text('verify.txt')['content'] == 'first'
        for profile in ('list_workspace', 'disk_usage'):
            result = cmd.run_profile(profile)
            assert result['exit_code'] == 0 and not result['timed_out'], result
        env = dict(os.environ, JAN_MCP_WORKSPACE=str(work), JAN_MCP_STATE_DIR=str(root / 'remote-state'), JAN_MCP_ALLOW_WRITES='0')
        proc = subprocess.Popen([sys.executable, '-m', 'jan_mcp_commander.server'],
                                stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                text=True, encoding='utf-8', env=env)
        messages = queue.Queue()
        errors = []
        def output():
            for line in proc.stdout:
                messages.put(json.loads(line))
        def error():
            for line in proc.stderr:
                errors.append(line)
        threading.Thread(target=output, daemon=True).start()
        threading.Thread(target=error, daemon=True).start()
        def send(message):
            proc.stdin.write(json.dumps(message) + '\n')
            proc.stdin.flush()
        def receive(identifier):
            import time
            deadline = time.monotonic() + 20
            while time.monotonic() < deadline:
                try:
                    message = messages.get(timeout=1)
                except queue.Empty:
                    if proc.poll() is not None:
                        raise RuntimeError('MCP exited: ' + ''.join(errors)[-2000:])
                    continue
                if message.get('id') == identifier:
                    if 'error' in message:
                        raise RuntimeError(message['error'])
                    return message['result']
            raise RuntimeError('MCP response timed out: ' + ''.join(errors)[-2000:])
        try:
            send({'jsonrpc':'2.0','id':1,'method':'initialize','params':{'protocolVersion':'2025-11-25','capabilities':{},'clientInfo':{'name':'JAN verification','version':'1.0'}}})
            receive(1)
            send({'jsonrpc':'2.0','method':'notifications/initialized'})
            send({'jsonrpc':'2.0','id':2,'method':'tools/list','params':{}})
            listing = receive(2)
            tools = [t['name'] for t in listing['tools']]
            required = {'jan_status', 'jan_read_text', 'jan_run_profile', 'jan_skills', 'jan_route_skill', 'jan_skill_guide'}
            assert required.issubset(tools), tools
            for identifier, name, arguments in [(3,'jan_status',{}),(4,'jan_read_text',{'path':'verify.txt'}),(5,'jan_run_profile',{'name':'list_workspace'})]:
                send({'jsonrpc':'2.0','id':identifier,'method':'tools/call','params':{'name':name,'arguments':arguments}})
                result = receive(identifier)
                assert not result.get('isError'), result
            send({'jsonrpc':'2.0','id':6,'method':'tools/call','params':{'name':'jan_write_text','arguments':{'path':'denied.txt','content':'blocked'}}})
            assert receive(6).get('isError'), 'Remote default must deny writes'
            assert not (work / 'denied.txt').exists()
            print(json.dumps({'verified':True,'transport':'local-stdio','tools':tools,'checks':['backup_restore','portable_profiles','MCP_initialize','MCP_discovery','MCP_tool_calls'],'chatgpt_connected':False}))
        finally:
            proc.terminate()
            try:
                proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                proc.kill()
            proc.stdin.close()


if __name__ == '__main__':
    verify()
