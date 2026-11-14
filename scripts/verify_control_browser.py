"""Native Chromium integration against an owned synthetic HTTP page only."""
import hashlib
import json
import os
from pathlib import Path
import tempfile
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from jan_mcp_commander.control import ControlCommander

HTML=b'''<!doctype html><title>JAN synthetic browser test</title><label for="name">Name</label><input id="name"><input type="password" id="password"><button id="save" onclick="document.getElementById('result').textContent=document.getElementById('name').value">Save</button><p id="result"></p>'''
class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        self.send_response(200); self.send_header('Content-Type','text/html'); self.end_headers(); self.wfile.write(HTML)
    def log_message(self,*args):pass

def verify(channel='chromium'):
    with tempfile.TemporaryDirectory(prefix='jan-browser-check-') as directory:
        root=Path(directory); work=root/'workspace'; work.mkdir()
        old=os.environ.get('JAN_MCP_STATE_DIR')
        os.environ['JAN_MCP_STATE_DIR']=str(root/'state')
        server=ThreadingHTTPServer(('127.0.0.1',0),Handler)
        threading.Thread(target=server.serve_forever,daemon=True).start()
        commander=ControlCommander(work,enabled={'browser'},headless=True,browser_channel=channel)
        try:
            url='http://127.0.0.1:'+str(server.server_port)
            assert commander.browser_action('open',url)['title']=='JAN synthetic browser test'
            commander.browser_action('fill','#name','JAN_BROWSER_OK')
            assert 'JAN_BROWSER_OK' in commander.browser_action('click','#save')['text']
            try:commander.browser_action('fill','#password','SYNTHETIC_NOT_A_REAL_PASSWORD')
            except ValueError:pass
            else:raise AssertionError('Password field accepted remote fill')
            screenshot=commander.browser_action('screenshot')
            assert screenshot['mime_type']=='image/jpeg' and screenshot['data']
            first=commander.browser_action('tabs')['tabs'][0]['tab_id']
            commander.browser_action('new_tab',url)
            assert len(commander.browser_action('tabs')['tabs'])==2
            commander.browser_action('select_tab',first)
            assert 'JAN_BROWSER_OK' in commander.browser_action('snapshot')['text']
            commander.browser_action('close_tab',first)
            assert len(commander.browser_action('tabs')['tabs'])==1
            commander.browser_action('close')
            return {'native_browser_verified':True,'browser_channel':channel,'form_fill_click_verified':True,
                    'password_fill_denied':True,'screenshot_verified':True,'tabs_verified':True,
                    'synthetic_localhost_only':True,'public_oauth_verified':False,'desktop_input_verified':False}
        finally:
            commander.close_control();server.shutdown();server.server_close()
            if old is None:os.environ.pop('JAN_MCP_STATE_DIR',None)
            else:os.environ['JAN_MCP_STATE_DIR']=old

if __name__=='__main__':
    import argparse
    p=argparse.ArgumentParser();p.add_argument('--channel',default='chromium');a=p.parse_args()
    print(json.dumps(verify(a.channel)))
