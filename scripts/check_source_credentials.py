"""Bounded scan of Git-visible source; never print matching secret values."""
from pathlib import Path
import re
import subprocess

LIMIT = 16 * 1024 * 1024
PATTERNS = (
    rb'gh[pousr]_[A-Za-z0-9]{30,}',
    rb'github_pat_[A-Za-z0-9_]{40,}',
    rb'npm_[A-Za-z0-9]{30,}',
    rb'AKIA[0-9A-Z]{16}',
    rb'sb_secret_[A-Za-z0-9_-]{20,}',
    rb'-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----[\r\n]+[A-Za-z0-9+/=\r\n]{100,}',
)


def scan(root):
    root = Path(root).resolve()
    names = subprocess.check_output(
        ['git', 'ls-files', '--cached', '--others', '--exclude-standard', '-z'], cwd=root,
    ).decode('utf-8').split('\0')
    findings = []
    for name in sorted(set(names) - {''}):
        path = root / name
        parts = Path(name).parts
        private = (any(part in {'.venv', 'node_modules', '.wrangler', 'state', '__pycache__'} for part in parts)
                   or (path.name.startswith('.env') and path.name != '.env.example')
                   or path.name.startswith('.dev.vars') or path.suffix in {'.key', '.enc'}
                   or path.name in {'connection.json', '.npmrc'})
        if private:
            findings.append((name, 'private-state path'))
        elif not path.resolve().is_relative_to(root) or path.is_symlink():
            findings.append((name, 'linked source path'))
        elif not path.is_file() or path.stat().st_size > LIMIT:
            findings.append((name, 'missing or oversized source'))
        else:
            with path.open('rb') as source:
                raw = source.read(LIMIT + 1)
            if len(raw) > LIMIT:
                findings.append((name, 'oversized source'))
            elif any(re.search(pattern, raw) for pattern in PATTERNS):
                findings.append((name, 'credential pattern'))
    return findings


def main(root):
    results = scan(root)
    for name, rule in results:
        safe_name = name.encode('utf-8')
        for pattern in PATTERNS:
            safe_name = re.sub(pattern, b'[redacted]', safe_name)
        print(f'{safe_name.decode("utf-8")!r}: {rule}')
    print(f'Source credential scan: {len(results)} findings')
    return int(bool(results))


if __name__ == '__main__':
    raise SystemExit(main(Path(__file__).resolve().parents[1]))
