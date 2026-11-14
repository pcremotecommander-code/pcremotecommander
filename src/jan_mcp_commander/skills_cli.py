"""Local skill management; routing never invokes application actions."""
import argparse
import json
from pathlib import Path
from .skills import catalog, route, guide, export_skill, Feedback

def main(argv, workspace=None):
    parser=argparse.ArgumentParser(prog='pcremotecommander cli skills',description='Advisory workflows and opt-in metadata feedback; never automatic execution')
    sub=parser.add_subparsers(dest='action',required=True)
    sub.add_parser('list');sub.add_parser('guide')
    routing=sub.add_parser('route');routing.add_argument('request');routing.add_argument('--skill')
    export=sub.add_parser('export');export.add_argument('--destination',required=True);export.add_argument('--skill',choices=['pcrc-commander','jan-commander','pcrc-computer-use'],default='pcrc-commander')
    feedback=sub.add_parser('feedback');feedback.add_argument('operation',choices=['status','enable','disable','clear','record'])
    feedback.add_argument('--category');feedback.add_argument('--skill');feedback.add_argument('--method');feedback.add_argument('--outcome')
    feedback.add_argument('--correction',default='');feedback.add_argument('--reviewed',action='store_true')
    args=parser.parse_args(argv)
    try:
        if args.action=='list':result=catalog()
        elif args.action=='guide':result=guide()
        elif args.action=='route':result=route(args.request,args.skill)
        elif args.action=='export':result=export_skill(args.destination,args.skill)
        else:
            from .cli import workspace_path
            from .portable import PortableCommander
            cmd=PortableCommander(workspace_path(workspace));service=Feedback(cmd._store)
            if args.operation=='status':result=service.status()
            elif args.operation in {'enable','disable'}:result=service.configure(args.operation=='enable')
            elif args.operation=='clear':result=service.clear()
            else:result=service.record(args.category,args.skill,args.method,args.outcome,args.correction,args.reviewed)
        print(json.dumps(result,ensure_ascii=False));return 0
    except (ValueError,OSError,TypeError):
        print(json.dumps({'error':'Invalid skill/feedback input or private storage unavailable; check IDs and local configuration'}));return 1
