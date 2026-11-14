"""Read-only post-deployment probes; never prints cookies or OAuth query values."""
import json
from pathlib import Path
import urllib.error
import urllib.parse
import urllib.request
import time


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self,*args,**kwargs):return None


def main():
    public='https://pc-remote-commander.pcremotecommander.workers.dev'
    owner='https://pc-remote-commander-ops.pcremotecommander.workers.dev'
    checks=[(public,'/',200),(public,'/prompts/',200),(public,'/.well-known/oauth-authorization-server',200),
        (public,'/.well-known/oauth-protected-resource',200),(public,'/mcp',401),(public,'/devices',200),
        (public,'/devices/email/signup',200),(owner,'/admin',200)]
    opener=urllib.request.build_opener(NoRedirect());results=[]
    for origin,path,expected in checks:
        request=urllib.request.Request(origin+path,headers={'User-Agent':'PCRC-release-validation'})
        retries=0
        for attempt in range(3):
            try:response=opener.open(request,timeout=30);break
            except urllib.error.HTTPError as exc:response=exc;break
            except (urllib.error.URLError,TimeoutError):
                if attempt==2:raise
                retries+=1;time.sleep(1)
        with response:
            status=response.code;headers=response.headers
            result={'origin':origin,'path':path,'status':status,'expected':expected,'network_retries':retries}
            if path=='/mcp':
                result['oauth_challenge']=bool(headers.get('WWW-Authenticate'));assert result['oauth_challenge']
            if path in {'/devices','/admin'}:
                body=response.read(2*1024*1024).decode('utf-8')
                result['sign_in_page']=('/owner/login' in body if path=='/admin' else 'data-auth-mode="signin"' in body)
                assert result['sign_in_page'],result
                assert 'no-store' in headers.get('Cache-Control',''),result
            assert status==expected,result
            results.append(result)
    output={'passed':True,'requests':results,'authenticated_execution_tested':False,'payment_charged':False}
    (Path(__file__).resolve().parents[1]/'work/public-routes-validation.json').write_text(json.dumps(output,indent=2))
    print(json.dumps(output))


if __name__=='__main__':main()
