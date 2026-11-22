"""Local skill management; routing never invokes application actions."""
import argparse
import json
from pathlib import Path
from .portable_skills import AGENTS, SKILLS, list_portable, manage_skills, skill_info
from .skills import catalog, route, guide, export_skill, Feedback

def main(argv, workspace=None):
    parser=argparse.ArgumentParser(prog='pcremotecommander cli skills',description='Discover, install and suggest bundled Agent Skills. Suggestions never run tools.')
    sub=parser.add_subparsers(dest='action',required=True)
    sub.add_parser('list');sub.add_parser('guide')
    search = sub.add_parser('search')
    search.add_argument('query')
    info = sub.add_parser('info')
    info.add_argument('skill', choices=SKILLS)
    for action in ('install', 'update', 'uninstall', 'installed'):
        command = sub.add_parser(action)
        command.add_argument('--agent', choices=AGENTS, required=action in {'install', 'uninstall'})
        command.add_argument('--dry-run', action='store_true')
        if action in {'install', 'uninstall'}:
            command.add_argument('skill', choices=SKILLS, nargs='?' if action == 'install' else None)
        if action == 'install':
            command.add_argument('--all', action='store_true')
    routing=sub.add_parser('route', aliases=['suggest'], help='Suggest an advisory workflow for a task');routing.add_argument('request');routing.add_argument('--skill')
    export=sub.add_parser('export');export.add_argument('--destination',required=True);export.add_argument('--skill',choices=['pcrc-commander','jan-commander','pcrc-computer-use'],default='pcrc-commander')
    feedback=sub.add_parser('feedback');feedback.add_argument('operation',choices=['status','enable','disable','clear','record'])
    feedback.add_argument('--category');feedback.add_argument('--skill');feedback.add_argument('--method');feedback.add_argument('--outcome')
    feedback.add_argument('--correction',default='');feedback.add_argument('--reviewed',action='store_true')
    args=parser.parse_args(argv)
    try:
        if args.action=='list':result=catalog()
        elif args.action == 'search':
            result = {'skills': list_portable(args.query)}
        elif args.action == 'info':
            result = skill_info(args.skill, full=True)
        elif args.action in {'install', 'update', 'uninstall', 'installed'}:
            skill = getattr(args, 'skill', None)
            if args.action == 'install' and bool(skill) == args.all:
                parser.error('install requires one skill or --all')
            agents = [args.agent] if args.agent else list(AGENTS)
            result = {'agents': [manage_skills(args.action, agent, [skill] if skill else None, args.dry_run)
                                 for agent in agents]}
        elif args.action=='guide':result=guide()
        elif args.action in {'route','suggest'}:result=route(args.request,args.skill)
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
