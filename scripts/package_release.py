"""Build the single release archive with audited tunnel assets; exclude private state and local settings."""
import argparse
import hashlib
import json
from pathlib import Path
import tomllib
import zipfile

ROOT=Path(__file__).resolve().parents[1]
EXCLUDE={'.venv','node_modules','.wrangler','build','dist','__pycache__','.pytest_cache','tools','secrets','state','.git'}
SUFFIXES={'.py','.md','.json','.jsonc','.toml','.lock','.sh','.ps1','.cmd','.yaml','.yml','.txt',
          '.ts','.mts','.cts','.js','.mjs','.cjs'}
PRIVATE={'connection.json','wrangler.local.jsonc','.dev.vars','release-manifest.json'}

def files():
    for top in sorted(ROOT.iterdir()):
        if top.is_dir() and top.name not in {'src','scripts','tests','deploy','docs'}:continue
        candidates=top.rglob('*') if top.is_dir() else [top]
        for path in sorted(candidates):
            rel=path.relative_to(ROOT)
            if any(part in EXCLUDE or part.endswith('.egg-info') for part in rel.parts):continue
            if path.name in PRIVATE or path.name.startswith('.env'):continue
            if path.is_symlink():raise ValueError('Linked release file: '+str(rel))
            if not path.is_file():continue
            native = rel.parts[:3] == ('src','jan_mcp_commander','vendor') and path.name in {
                '2026.10.0-jan.1-cloudflared-linux-amd64', '2026.10.0-jan.1-cloudflared-linux-arm64',
                '2026.10.0-jan.1-cloudflared-windows-amd64.exe'}
            if path.suffix not in SUFFIXES and path.name not in {'Dockerfile','.gitignore','.dockerignore','go.mod','go.sum'} and not native:continue
            yield path


def main():
    parser=argparse.ArgumentParser();parser.add_argument('output',type=Path);args=parser.parse_args()
    selected=list(files())
    provenance=json.loads((ROOT/'src/jan_mcp_commander/vendor/build-provenance.json').read_text())
    for name,item in provenance['artifacts'].items():
        binary=ROOT/'src/jan_mcp_commander/vendor'/name
        assert binary in selected and hashlib.sha256(binary.read_bytes()).hexdigest()==item['sha256'], 'Bundled tunnel integrity failure'
    version=tomllib.loads((ROOT/'pyproject.toml').read_text())['project']['version']
    manifest={'version':version,'production_ready':False,'files':{p.relative_to(ROOT).as_posix():hashlib.sha256(p.read_bytes()).hexdigest() for p in selected}}
    path=ROOT/'release-manifest.json';path.write_text(json.dumps(manifest,indent=2)+'\n')
    with zipfile.ZipFile(args.output,'w',zipfile.ZIP_DEFLATED) as archive:
        for p in [*selected,path]:archive.write(p,'jan-mcp-commander/'+p.relative_to(ROOT).as_posix())
    with zipfile.ZipFile(args.output) as archive:
        assert archive.testzip() is None
        for name,digest in manifest['files'].items():assert hashlib.sha256(archive.read('jan-mcp-commander/'+name)).hexdigest()==digest
    print(json.dumps({'archive':str(args.output.resolve()),'files':len(selected)+1,'bytes':args.output.stat().st_size,'sha256':hashlib.sha256(args.output.read_bytes()).hexdigest(),'manifest_verified':True,'production_ready':False}))

if __name__=='__main__':main()
