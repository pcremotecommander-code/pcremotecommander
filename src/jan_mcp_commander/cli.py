"""Local interactive and one-shot commands. English aliases never execute a shell."""
from __future__ import annotations

import argparse
from dataclasses import dataclass
import json
import os
from pathlib import Path
import re
import sys
from .core import PermissionDenied
from .portable import PortableCommander
from . import __version__

VERSION = __version__
HELP = '''Commands (paths are relative to the workspace):
  status / show status
  list files / list files in folder
  read file notes.txt
  find files named report
  info notes.txt
  disk usage / show disk space
  diagnostic python_version / uname
  write file notes.txt          enter text, finish with .end; .cancel cancels
  overwrite file notes.txt      explicitly replace a file, keeping a backup
  restore BACKUP_ID
  start session list_workspace / disk_usage
  sessions / output SESSION_ID / stop session SESSION_ID
  help / exit
  development inspect / preview / receipt / apply (use development --help)
  skills list / guide / route / export / feedback (use skills --help)

This is a local command interface, with a defined set of English aliases.
Writes require --allow-writes. Git execution is disabled.
No conversational AI model or arbitrary shell execution is configured.
Use forward slashes in paths. Quotes around a whole path are optional.
In multiline text, type ..end or ..cancel to save the literal .end or .cancel.'''


@dataclass(frozen=True)
class Request:
    action: str
    argument: str = ''


def _argument(value: str) -> str:
    value = value.strip()
    if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
        value = value[1:-1]
    if not value or '\x00' in value:
        raise ValueError('A non-empty argument is required.')
    return value


def parse_request(text: str) -> Request:
    text = text.strip()
    aliases = {
        'help': 'help', '?': 'help', 'what can you do': 'help',
        'exit': 'exit', 'quit': 'exit', 'bye': 'exit',
        'status': 'status', 'show status': 'status',
        'list': 'list', 'ls': 'list', 'list files': 'list', 'show files': 'list',
        'sessions': 'sessions', 'list sessions': 'sessions',
        'disk': 'disk', 'disk usage': 'disk', 'show disk space': 'disk',
        'git status': 'git',
    }
    normalized = ' '.join(text.casefold().split())
    if normalized in aliases:
        return Request(aliases[normalized], '.' if aliases[normalized] == 'list' else '')
    patterns = (
        (r'(?:list files in|show files in|list|ls)\s+(.+)', 'list'),
        (r'(?:read file|read|cat)\s+(.+)', 'read'),
        (r'(?:find files (?:named|matching)|find files|find)\s+(.+)', 'find'),
        (r'(?:file info|info)\s+(.+)', 'info'),
        (r'(?:write file|write)\s+(.+)', 'write'),
        (r'(?:overwrite file|overwrite)\s+(.+)', 'overwrite'),
        (r'restore\s+([a-fA-F0-9]{32})', 'restore'),
        (r'(?:diagnostic|diagnose)\s+(\w+)', 'diagnostic'),
        (r'start session\s+(\w+)', 'start'),
        (r'(?:session output|output)\s+([a-fA-F0-9]{32})', 'output'),
        (r'(?:stop session|stop)\s+([a-fA-F0-9]{32})', 'stop'),
        (r'run profile\s+(\w+)', 'profile'),
    )
    for pattern, action in patterns:
        match = re.fullmatch(pattern, text, re.IGNORECASE)
        if match:
            argument = _argument(match.group(1))
            if action in {'restore', 'output', 'stop', 'diagnostic', 'start', 'profile'}:
                argument = argument.lower()
            return Request(action, argument)
    raise ValueError('Command not understood. Type help for supported commands.')


def display_text(text: str) -> str:
    """Keep file content from injecting terminal control sequences."""
    return ''.join(c if (c in '\n\t' or (ord(c) >= 32 and not 127 <= ord(c) <= 159))
                   else f'\\x{ord(c):02x}' for c in text)


class Console:
    def __init__(self, commander: PortableCommander, reader=input, writer=print):
        self.commander, self.reader, self.writer = commander, reader, writer

    def _content(self) -> str:
        self.writer('Enter text; .end saves, .cancel cancels. Blank lines are preserved.')
        lines = []
        total = 0
        while True:
            line = self.reader('... ')
            if line == '.cancel':
                raise ValueError('Write cancelled; no file was changed.')
            if line == '.end':
                return '\n'.join(lines)
            if line in {'..end', '..cancel'}:
                line = line[1:]
            total += len(line.encode('utf-8')) + (1 if lines else 0)
            if total > 65536:
                raise ValueError('Write cancelled: text exceeds 64 KiB.')
            lines.append(line)

    def execute(self, request: Request, *, content=None, interactive=False):
        cmd = self.commander
        action, arg = request.action, request.argument
        if content is not None and action not in {'write', 'overwrite'}:
            raise ValueError('--content is only valid with write or overwrite.')
        if action == 'help':
            return {'help': HELP}
        if action == 'exit':
            return {'exit': True}
        if action == 'status':
            return {**cmd.status(), 'mode': 'interactive-cli' if interactive else 'cli'}
        if action == 'list':
            return cmd.list_files(arg)
        if action == 'read':
            return cmd.read_text(arg)
        if action == 'find':
            return cmd.find_files(arg)
        if action == 'info':
            return cmd.file_info(arg)
        if action in {'disk', 'git', 'profile'}:
            return cmd.run_profile({'disk': 'disk_usage', 'git': 'git_status'}.get(action, arg))
        if action == 'diagnostic':
            return cmd.diagnostic(arg)
        if action in {'write', 'overwrite'}:
            cmd._path(arg, exists=False)
            if content is None:
                if not interactive:
                    raise ValueError('Use --content TEXT for a one-shot write, or open interactive mode.')
                content = self._content()
            return cmd.write_text(arg, content, overwrite=action == 'overwrite')
        if action == 'restore':
            return cmd.restore_backup(arg)
        if action == 'start':
            if not interactive:
                raise ValueError('Start sessions inside interactive mode so PCRC can manage their lifetime.')
            return cmd.start_session(arg)
        if action == 'sessions':
            return cmd.list_sessions()
        if action == 'output':
            return cmd.session_output(arg)
        if action == 'stop':
            return cmd.stop_session(arg)
        raise ValueError('Unsupported action.')

    def show(self, result):
        if 'help' in result:
            self.writer(result['help'])
        elif 'content' in result:
            self.writer(display_text(result['content']))
        elif 'entries' in result:
            for entry in result['entries']:
                self.writer(display_text(f"{entry['kind']:10} {entry['name']}"))
            self.writer(f"{len(result['entries'])} entries shown (limit {result['limit']}).")
        elif 'output' in result:
            self.writer(display_text(result['output']))
            self.writer(f"Exit: {result.get('exit_code')}; timed out: {result.get('timed_out', False)}; truncated: {result.get('truncated', False)}")
        else:
            self.writer(json.dumps(result, indent=2, ensure_ascii=False))

    def close(self):
        for identifier in list(self.commander._sessions):
            try:
                self.commander.stop_session(identifier)
            except (ValueError, OSError, RuntimeError):
                # Audit failures must not leave CLI-owned processes running after exit.
                entry = self.commander._sessions.pop(identifier, None)
                if entry is not None:
                    self.commander._terminate(entry['process'])
                    entry['done'].wait(5)

    def run(self):
        self.writer(f'PC Remote Commander CLI {VERSION}')
        self.writer('Workspace: ' + display_text(str(self.commander.workspace)))
        self.writer('Type help for commands, exit to close. Local command mode; no AI model configured.')
        try:
            while True:
                try:
                    line = self.reader('PCRC> ')
                    if not line.strip():
                        continue
                    request = parse_request(line)
                    if request.action == 'exit':
                        break
                    self.show(self.execute(request, interactive=True))
                except EOFError:
                    break
                except KeyboardInterrupt:
                    self.writer('\nCancelled.')
                except (ValueError, OSError, RuntimeError) as exc:
                    self.writer('Error: ' + display_text(str(exc)))
        finally:
            self.close()


def workspace_path(explicit=None) -> Path:
    selected = explicit or os.environ.get('JAN_MCP_WORKSPACE')
    if selected:
        return Path(selected).expanduser()
    config = Path(__file__).resolve().parents[2] / 'connection.json'
    if config.exists():
        value = json.loads(config.read_text(encoding='utf-8-sig'))
        if not isinstance(value, dict) or not isinstance(value.get('workspace'), str) or not value['workspace']:
            raise ValueError('connection.json must contain a workspace path.')
        return Path(value['workspace']).expanduser()
    default = Path.home() / 'PCRC-Workspace'
    default.mkdir(parents=True, exist_ok=True)
    return default


def main(argv=None) -> int:
    supplied=list(sys.argv[1:] if argv is None else argv)
    probe=argparse.ArgumentParser(add_help=False)
    probe.add_argument('--workspace')
    known, remaining=probe.parse_known_args(supplied)
    if remaining and remaining[0]=='development':
        from .development import main as development_main
        return development_main(remaining[1:],workspace=known.workspace)
    if remaining and remaining[0]=='documents':
        from .document_workflow import main as documents_main
        return documents_main(remaining[1:],workspace=known.workspace)
    if remaining and remaining[0]=='media':
        from .media_tools import main as media_main
        return media_main(remaining[1:],workspace=known.workspace)
    if remaining and remaining[0]=='pdf':
        from .pdf_tools import main as pdf_main
        return pdf_main(remaining[1:], workspace=known.workspace)
    if remaining and remaining[0]=='skills':
        from .skills_cli import main as skills_main
        return skills_main(remaining[1:],workspace=known.workspace)
    if remaining and remaining[0]=='remote':
        from .remote import main as remote_main
        return remote_main(remaining[1:]+(['--workspace',known.workspace] if known.workspace else []))
    parser = argparse.ArgumentParser(description='PCRC interactive command line and local tool runner')
    parser.add_argument('--workspace', help='Approved existing workspace directory')
    parser.add_argument('--allow-writes', action='store_true', help='Explicitly enable local writes and restore for this process')
    parser.add_argument('--command', help='One command, such as "list files"')
    parser.add_argument('--content', help='Literal text for a one-shot write/overwrite')
    parser.add_argument('--json', action='store_true', help='Return a JSON result for a one-shot command')
    parser.add_argument('--version', action='version', version=f'PC Remote Commander {VERSION}')
    parser.add_argument('request', nargs='*', help='Command words, or chat/serve')
    args = parser.parse_args(argv)
    if args.allow_writes:
        os.environ['JAN_MCP_ALLOW_WRITES'] = '1'
    text = args.command or ' '.join(args.request)
    if args.command and args.request:
        parser.error('Use --command or positional command words, not both.')
    if text.strip().lower() == 'serve':
        if args.content is not None or args.json:
            parser.error('serve uses MCP stdio; --content and --json do not apply.')
        try:
            os.environ['JAN_MCP_WORKSPACE'] = str(workspace_path(args.workspace).resolve(strict=True))
        except (ValueError, OSError) as exc:
            parser.error(str(exc))
        from .server import main as serve
        serve()
        return 0
    interactive = not text or text.strip().lower() == 'chat'
    if interactive and (args.json or args.content is not None):
        parser.error('--json and --content require a one-shot command.')
    console = None
    try:
        # Help can be displayed without reading or creating any workspace.
        request = None if interactive else parse_request(text)
        if request and request.action == 'help':
            print(json.dumps({'help': HELP}) if args.json else HELP)
            return 0
        console = Console(PortableCommander(workspace_path(args.workspace)))
        if interactive:
            console.run()
        else:
            result = console.execute(request, content=args.content)
            print(json.dumps(result, ensure_ascii=False)) if args.json else console.show(result)
        return 0
    except (ValueError, OSError, RuntimeError) as exc:
        if args.json:
            print(json.dumps({'error': str(exc)}))
        else:
            print('Error: ' + display_text(str(exc)), file=sys.stderr)
        return 1
    finally:
        if console is not None:
            console.close()


if __name__ == '__main__':
    raise SystemExit(main())
