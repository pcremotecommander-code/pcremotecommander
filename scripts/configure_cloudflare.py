"""Create account-specific, non-secret Worker configuration without editing templates."""
import argparse
import json
from pathlib import Path
import re
from urllib.parse import urlsplit


def origin(value, suffix):
    parsed=urlsplit(value)
    pattern=r'[a-z0-9-]+\.[a-z0-9-]+\.workers\.dev' if suffix=='workers.dev' else r'[a-z0-9-]+\.trycloudflare\.com'
    if parsed.scheme!='https' or not re.fullmatch(pattern,parsed.netloc) or parsed.path not in ('','/') or parsed.query or parsed.fragment:
        raise ValueError('Use an exact HTTPS '+suffix+' origin, without credentials, port, path or query')
    return 'https://'+parsed.netloc


def main(argv=None):
    parser=argparse.ArgumentParser(description='JAN Cloudflare non-secret deployment configuration')
    parser.add_argument('--worker-origin')
    parser.add_argument('--tunnel-origin',required=True)
    parser.add_argument('--github-client-id')
    parser.add_argument('--github-id')
    parser.add_argument('--kv-id')
    parser.add_argument('--update-origin',action='store_true',help='Only replace the origin in an existing local config')
    args=parser.parse_args(argv)
    worker=Path(__file__).resolve().parents[1]/'deploy/cloudflare/worker'
    target=worker/'wrangler.local.jsonc'
    try:
        upstream=origin(args.tunnel_origin,'trycloudflare.com')
        if args.update_origin:
            config=json.loads(target.read_text())
            config['vars']['JAN_ORIGIN']=upstream
            template=json.loads((worker/'wrangler.jsonc').read_text())
            config.setdefault('durable_objects',template['durable_objects'])
            config.setdefault('migrations',template['migrations'])
            config.setdefault('secrets',template['secrets'])
            config['vars']['JAN_AUTO_ORIGIN']='1'
        else:
            public=origin(args.worker_origin or '','workers.dev')
            if not re.fullmatch(r'[A-Za-z0-9_]{8,64}',args.github_client_id or ''):raise ValueError('Invalid GitHub OAuth client ID')
            if not re.fullmatch(r'[0-9]{1,20}',args.github_id or ''):raise ValueError('Use your numeric GitHub ID')
            if not re.fullmatch(r'[a-f0-9]{32}',args.kv_id or ''):raise ValueError('Use the Workers KV namespace ID')
            config=json.loads((worker/'wrangler.jsonc').read_text())
            config['name']=urlsplit(public).hostname.split('.')[0]
            config['vars']={'JAN_PUBLIC_ORIGIN':public,'JAN_ORIGIN':upstream,'GITHUB_CLIENT_ID':args.github_client_id,'ALLOWED_GITHUB_ID':args.github_id,'JAN_AUTO_ORIGIN':'1'}
            config['kv_namespaces'][0]['id']=args.kv_id
        # The config contains public routing/identity only; secret upload is separate.
        with target.open('w' if args.update_origin else 'x',encoding='utf-8') as output:
            output.write(json.dumps(config,indent=2)+'\n')
        print('Configured '+str(target)+'. No credentials stored. Deploy using --config wrangler.local.jsonc.')
        return 0
    except (OSError,ValueError,TypeError) as exc:
        parser.exit(1,'JAN Cloudflare setup: '+str(exc)+'\n')

if __name__=='__main__':raise SystemExit(main())
