"""Bundled Agent Skills and explicit, local-only installation."""
from functools import lru_cache
from hashlib import sha256
from importlib.resources import files
import json
import os
from pathlib import Path
import re

from .safe_fs import SafeTree, check

AGENTS = {'codex': '.agents/skills', 'claude': '.claude/skills'}
MARKER = '.pcrc-skill.json'
MAX_SIZE = 32768
PACKS = {
    'computer-operations': 'computer-diagnostics system-information process-management application-management desktop-automation',
    'file-management': 'file-search file-management file-editing directory-organization file-transfer',
    'browser-work': 'browser-navigation browser-research browser-form-automation browser-workflow-creation browser-workflow-execution',
    'development': 'project-inspection code-execution debugging development-environment-setup dependency-management testing-and-validation',
    'troubleshooting': 'connection-diagnostics network-diagnostics system-troubleshooting error-investigation',
}
SKILLS = {name: pack for pack, names in PACKS.items() for name in names.split()}
PROJECT_SEQUENCE = ['project-inspection', 'dependency-management', 'debugging', 'code-execution', 'testing-and-validation']


@lru_cache(maxsize=len(SKILLS))
def _skill(name):
    if name not in SKILLS:
        raise ValueError('Unknown bundled skill')
    content = files('jan_mcp_commander').joinpath('skill_data', name, 'SKILL.md').read_text(encoding='utf-8')
    match = re.match(r'\A---\nname: ([a-z][a-z0-9-]{0,63})\ndescription: (.+)\nmetadata:\n  version: "(\d+\.\d+\.\d+)"\n---\n', content)
    if not match or match[1] != name or '--' in name or len(content.encode()) > MAX_SIZE:
        raise ValueError('Invalid bundled skill metadata')
    description = json.loads(match[2])
    section = re.search(r'^## Required PCRC tools\n\n(.+)$', content, re.MULTILINE)
    tools = re.findall(r'\x60([a-z][a-z0-9_]+)\x60', section[1]) if section else []
    if not isinstance(description, str) or not 0 < len(description) <= 1024 or not tools:
        raise ValueError('Invalid bundled skill description or tool list')
    return description, match[3], tuple(tools), content


def skill_info(name, full=False):
    description, version, tools, content = _skill(name)
    result = {'id': name, 'description': description, 'version': version, 'tools': list(tools), 'pack': SKILLS[name]}
    if full:
        result.update(content=content, advisory_only=True, permissions_granted=False)
    return result


def list_portable(query=''):
    terms = query.casefold().split()
    return [item for item in map(skill_info, SKILLS) if all(
        term in item['id'] + ' ' + item['description'].casefold() for term in terms
    )]


def suggest_portable(request):
    if all(re.search(pattern, request, re.IGNORECASE) for pattern in (
        r'\b(project|repository|codebase)\b', r'\b(dependenc\w*|lockfile|requirements)\b',
        r'\b(error|fix|debug\w*)\b', r'\btests?\b',
    )):
        return [skill_info(name) for name in PROJECT_SEQUENCE]
    return []


def _agent_tree(agent, create):
    if agent not in AGENTS:
        raise ValueError('Unsupported agent')
    home = Path.home().absolute()
    for parent in reversed((home, *home.parents)):
        check(parent.lstat(), directory=True)
    tree = SafeTree(home, internal=True)
    directories = Path(AGENTS[agent]).parts
    for i in range(1, len(directories) + 1):
        relative = '/'.join(directories[:i])
        try:
            tree.info(relative)
        except FileNotFoundError:
            if not create:
                return None
            try:
                tree.mkdir(relative)
            except FileExistsError:
                pass
        check(tree.info(relative), directory=True)
    return tree


def _installed(tree, directory, name):
    if tree is None:
        return None
    try:
        check(tree.info(directory), directory=True)
    except FileNotFoundError:
        return None
    try:
        marker = json.loads(tree.read(f'{directory}/{MARKER}', 4096))
        payload = tree.read(f'{directory}/SKILL.md', MAX_SIZE)
    except FileNotFoundError as error:
        raise ValueError(f'{name} is not a complete PCRC-managed installation') from error
    if (not isinstance(marker, dict) or marker.get('owner') != 'PCRC' or marker.get('id') != name
        or not isinstance(marker.get('releases'), dict)):
        raise ValueError('Invalid PCRC installation metadata')
    digest = sha256(payload).hexdigest()
    version = marker['releases'].get(digest)
    if not isinstance(version, str) or not re.fullmatch(r'\d+\.\d+\.\d+', version):
        raise ValueError(f'{name} was edited locally and needs manual review')
    return version, digest


def manage_skills(action, agent, names=None, dry_run=False):
    if action not in {'installed', 'install', 'update', 'uninstall'}:
        raise ValueError('Invalid skill management action')
    for name in names or ():
        _skill(name)
    tree = _agent_tree(agent, create=action == 'install' and not dry_run)
    results = []
    for name in dict.fromkeys(names or SKILLS):
        directory = f'{AGENTS[agent]}/{name}'
        dest = Path.home() / directory
        try:
            current = _installed(tree, directory, name)
        except (ValueError, OSError):
            if names:
                raise
            results.append({'id': name, 'status': 'unmanaged_or_modified'})
            continue
        if action == 'installed':
            if current:
                results.append({'id': name, 'version': current[0], 'path': str(dest)})
            continue
        item = skill_info(name, full=True)
        payload = item['content'].encode()
        digest = sha256(payload).hexdigest()
        marker_path = f'{directory}/{MARKER}'
        skill_path = f'{directory}/SKILL.md'
        if action == 'uninstall':
            status = 'removed' if current else 'not_installed'
            if current and not dry_run:
                tree.unlink_file(skill_path)
                tree.unlink_file(marker_path)
                try:
                    with tree.parent(directory) as (parent, leaf):
                        if os.name == 'posix':
                            os.rmdir(leaf, dir_fd=parent)
                        else:
                            (parent / leaf).rmdir()
                except OSError:
                    pass  # Preserve any user-added files.
        elif action == 'update' and not current:
            continue
        elif current and current[1] == digest:
            status = 'current'
        elif current and action == 'install':
            status = 'update_available'
        else:
            status = 'updated' if current else 'installed'
            if not dry_run:
                releases = {digest: item['version']}
                if current:
                    # Allow the previous file until the atomic replacement succeeds.
                    releases[current[1]] = current[0]
                else:
                    tree.mkdir(directory)
                marker = {'owner': 'PCRC', 'id': name, 'releases': releases}
                tree.write(marker_path, json.dumps(marker).encode(), overwrite=bool(current))
                tree.write(skill_path, payload, overwrite=bool(current))
        results.append({'id': name, 'version': item['version'], 'status': status, 'path': str(dest)})
    return {'agent': agent, 'dry_run': dry_run, 'results': results}
