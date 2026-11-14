"""Defense in depth for pip I/O; approved installed package code is not OS-sandboxed."""
import ipaddress
import os
from pathlib import Path
import socket
import sys

stage=Path(sys.argv[1]).resolve(strict=True)
prefix=Path(sys.prefix).resolve();base=Path(sys.base_prefix).resolve()
roots=[stage,prefix,base]
write_roots=[stage]+([prefix] if prefix!=base else [])
if os.name!='nt':roots.extend(Path(p) for p in ['/etc/ssl/certs','/usr/share/ca-certificates'])

def allowed_path(value,write=False):
    if isinstance(value,int):return
    if value is None:return
    path=Path(os.fsdecode(value)).resolve()
    if path==Path(os.devnull).resolve():return
    if not any(path.is_relative_to(root) for root in (write_roots if write else roots)):raise PermissionError('Development pip filesystem scope denied')

def audit(event,args):
    if event=='open':
        mode=args[1];flags=args[2]
        write=(isinstance(mode,str) and any(c in mode for c in 'wax+')) or (isinstance(flags,int) and bool(flags&(os.O_WRONLY|os.O_RDWR|os.O_CREAT|os.O_TRUNC|os.O_APPEND)))
        allowed_path(args[0],write)
    elif event in {'os.remove','os.rmdir','os.mkdir','os.chmod','os.utime','os.truncate'}:allowed_path(args[0],True)
    elif event in {'os.rename','os.link','os.symlink'}:
        allowed_path(args[0],True);allowed_path(args[1],True)
    elif event in {'os.listdir','os.scandir'}:allowed_path(args[0] if args and args[0] is not None else '.')
    elif event=='socket.getaddrinfo':
        host=args[0]
        if isinstance(host,bytes):host=host.decode('ascii')
        if host not in {'pypi.org','files.pythonhosted.org'} or args[1] not in {443,'443'}:raise PermissionError('Development pip network destination denied')
    elif event=='socket.connect':
        address=args[1]
        if not isinstance(address,tuple) or len(address)<2 or address[1]!=443 or not ipaddress.ip_address(address[0]).is_global:raise PermissionError('Development pip network address denied')
    elif event in {'subprocess.Popen','os.system','os.exec','os.posix_spawn'}:
        raise PermissionError('Development pip build subprocess denied')

sys.addaudithook(audit)
from pip._internal.cli.main import main
raise SystemExit(main(sys.argv[2:]))
