"""Interactive, account-authorized workspace transfers over a direct private link."""
from __future__ import annotations

import argparse
import base64
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
import getpass
import hashlib
import hmac
import ipaddress
import json
import os
from pathlib import Path
import re
import secrets
import shutil
import socket
import ssl
import struct
import sys
import tempfile
import time
import urllib.request
import zlib

from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec, utils
from cryptography.x509.oid import NameOID

from .pairing_state import load_enrolled_credential
from .safe_fs import SafeTree, parts

CHUNK = 1024 * 1024
DEFAULT_MB = 120
FRAME = struct.Struct('!II')
HEADER = struct.Struct('!Q32s')
PROOF = struct.Struct('!Q86s')
PRIVATE_NETWORKS = tuple(map(ipaddress.ip_network, ('10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16')))
DEVICE = re.compile(r'[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}')


def private_ip(value):
    address = ipaddress.IPv4Address(value)
    if not any(address in network for network in PRIVATE_NETWORKS):
        raise ValueError('Choose a private IPv4 address for each computer.')
    return str(address)


def _read(stream, size):
    data = bytearray(size)
    view = memoryview(data)
    timeout = stream.gettimeout()
    deadline = time.monotonic() + timeout
    while view:
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise TimeoutError('Transfer read expired')
        stream.settimeout(remaining)
        count = stream.recv_into(view)
        if not count:
            raise ValueError('Transfer connection closed before completion.')
        view = view[count:]
    stream.settimeout(timeout)
    return bytes(data)


def _digest(fd, size):
    digest = hashlib.sha256()
    while size:
        data = os.read(fd, min(size, CHUNK))
        if not data:
            raise ValueError('Source changed while being read.')
        size -= len(data)
        digest.update(data)
    return digest.digest()


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None


class Enrollment:
    def __init__(self, credential, peer, receiving):
        session = credential['session']
        self.account = session['owner_id']
        self.source, self.destination = (peer, session['id']) if receiving else (session['id'], peer)
        if self.source == self.destination or not all(DEVICE.fullmatch(item) for item in (self.source, self.destination)):
            raise ValueError('Select two different enrolled device IDs.')
        if 'files' not in session['capabilities']:
            raise ValueError('File access must be approved for this device.')
        self.gateway = session['worker']
        self.key = serialization.load_pem_private_key(credential['privateKey'].encode('ascii'), None)

    def sign(self, session, timestamp):
        payload = '\n'.join(('PCRC_LAN_TRANSFER_V1', self.account, self.source, self.destination, session, str(timestamp)))
        signature = self.key.sign(payload.encode('ascii'), ec.ECDSA(hashes.SHA256()))
        r, s = utils.decode_dss_signature(signature)
        return base64.urlsafe_b64encode(r.to_bytes(32, 'big') + s.to_bytes(32, 'big')).rstrip(b'=')

    def verify(self, session, timestamp, sender, receiver):
        request = urllib.request.Request(
            self.gateway + '/device-transfer/verify',
            data=json.dumps(dict(owner_id=self.account, source=self.source, destination=self.destination,
                                 session=session, timestamp=timestamp, sender=sender.decode('ascii'),
                                 receiver=receiver.decode('ascii'))).encode('ascii'),
            headers={'Content-Type': 'application/json'},
        )
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), _NoRedirect())
        try:
            with opener.open(request, timeout=10) as response:
                if response.status == 204:
                    return
        except OSError:
            pass
        raise ValueError('PCRC could not verify both enrolled devices. Check that both are Online under the same account with file access.')


@contextmanager
def listener(bind_ip):
    key = ec.generate_private_key(ec.SECP256R1())
    name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, 'PCRC file transfer')])
    now = datetime.now(timezone.utc)
    cert = (x509.CertificateBuilder().subject_name(name).issuer_name(name).public_key(key.public_key())
            .serial_number(x509.random_serial_number()).not_valid_before(now - timedelta(minutes=1))
            .not_valid_after(now + timedelta(minutes=5)).sign(key, hashes.SHA256()))
    context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    context.minimum_version = ssl.TLSVersion.TLSv1_2
    with tempfile.TemporaryDirectory(prefix='pcrc-transfer-') as directory:
        pem = Path(directory) / 'session.pem'
        fd = os.open(pem, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, 'wb') as file:
            file.write(key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8,
                                         serialization.NoEncryption()) + cert.public_bytes(serialization.Encoding.PEM))
        context.load_cert_chain(pem)
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as server:
        server.bind((bind_ip, 0))
        server.listen(1)
        server.settimeout(120)
        pairing = cert.fingerprint(hashes.SHA256()).hex() + '.' + secrets.token_hex(32)
        yield server, context, pairing


def _authorize(stream, enrollment, session, receiving):
    if receiving:
        timestamp = int(time.time())
        receiver = enrollment.sign(session, timestamp)
        stream.sendall(PROOF.pack(timestamp, receiver))
        sender = _read(stream, 86)
        enrollment.verify(session, timestamp, sender, receiver)
        stream.sendall(b'\x01')
    else:
        timestamp, receiver = PROOF.unpack(_read(stream, PROOF.size))
        sender = enrollment.sign(session, timestamp)
        enrollment.verify(session, timestamp, sender, receiver)
        stream.sendall(sender)
        if _read(stream, 1) != b'\x01':
            raise ValueError('Destination did not authorize the transfer.')


def _inflate(data, size):
    decoder = zlib.decompressobj()
    try:
        plain = decoder.decompress(data, size + 1)
    except zlib.error as exc:
        raise ValueError('Invalid compressed transfer chunk.') from exc
    if len(plain) != size or not decoder.eof or decoder.unconsumed_tail or decoder.unused_data:
        raise ValueError('Invalid compressed transfer chunk size.')
    return plain


def receive(server, tls, pairing, peer_ip, tree, destination, maximum, enrollment):
    raw, address = server.accept()
    with raw:
        if address[0] != peer_ip:
            raise ValueError('Unexpected source network address.')
        raw.settimeout(20)
        with tls.wrap_socket(raw, server_side=True) as stream:
            pin, secret = pairing.split('.')
            if not hmac.compare_digest(_read(stream, 32), bytes.fromhex(secret)):
                raise ValueError('Transfer code did not match.')
            _authorize(stream, enrollment, pin, receiving=True)
            size, expected = HEADER.unpack(_read(stream, HEADER.size))
            if size > maximum:
                raise ValueError('File exceeds the receiving limit. Choose a higher --max-mb if approved.')
            if size > shutil.disk_usage(tree.root).free:
                raise ValueError('Destination is out of space.')
            try:
                tree.info(destination)
            except FileNotFoundError:
                pass
            else:
                raise ValueError('Destination already exists. Choose a new filename.')
            stream.sendall(b'\x01')
            digest = hashlib.sha256()
            wire_bytes = 0

            def chunks():
                nonlocal wire_bytes
                remaining = size
                deadline = time.monotonic() + 3600
                while remaining:
                    stream.settimeout(min(20, max(0.001, deadline - time.monotonic())))
                    if time.monotonic() >= deadline:
                        raise ValueError('Transfer exceeded one hour.')
                    plain, packed = FRAME.unpack(_read(stream, FRAME.size))
                    if not 0 < packed <= plain <= min(CHUNK, remaining):
                        raise ValueError('Invalid transfer chunk length.')
                    data = _read(stream, packed)
                    wire_bytes += packed
                    data = _inflate(data, plain) if packed < plain else data
                    digest.update(data)
                    remaining -= plain
                    yield data
                if not hmac.compare_digest(digest.digest(), expected):
                    raise ValueError('SHA-256 mismatch. The destination was not written.')
                stream.settimeout(20)
                _authorize(stream, enrollment, pin, receiving=True)

            tree.write_chunks(destination, chunks())
            stream.sendall(expected)
            return size, wire_bytes, expected.hex()


def send(tree, source, bind_ip, peer_ip, port, pairing, enrollment):
    if not re.fullmatch(r'[a-f0-9]{64}\.[a-f0-9]{64}', pairing):
        raise ValueError('Invalid transfer code.')
    pin, secret = pairing.split('.')
    context = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
    context.minimum_version = ssl.TLSVersion.TLSv1_2
    context.check_hostname = False
    context.verify_mode = ssl.CERT_NONE  # The one-time code pins the exact peer certificate below.
    with tree.open_read(source) as fd:
        size = os.fstat(fd).st_size
        expected = _digest(fd, size)
        os.lseek(fd, 0, os.SEEK_SET)
        with socket.create_connection((peer_ip, port), timeout=20, source_address=(bind_ip, 0)) as raw:
            with context.wrap_socket(raw) as stream:
                actual = hashlib.sha256(stream.getpeercert(binary_form=True)).hexdigest()
                if not hmac.compare_digest(pin, actual):
                    raise ValueError('Destination certificate did not match the transfer code.')
                stream.sendall(bytes.fromhex(secret))
                _authorize(stream, enrollment, pin, receiving=False)
                stream.sendall(HEADER.pack(size, expected))
                if _read(stream, 1) != b'\x01':
                    raise ValueError('Destination did not accept the file size.')
                remaining = size
                wire_bytes = 0
                deadline = time.monotonic() + 3600
                while remaining:
                    if time.monotonic() >= deadline:
                        raise ValueError('Transfer exceeded one hour.')
                    data = os.read(fd, min(remaining, CHUNK))
                    if not data:
                        raise ValueError('Source changed while being read.')
                    compressed = zlib.compress(data, level=3) if size >= CHUNK else data
                    payload = compressed if len(compressed) < len(data) else data
                    stream.sendall(FRAME.pack(len(data), len(payload)) + payload)
                    remaining -= len(data)
                    wire_bytes += len(payload)
                _authorize(stream, enrollment, pin, receiving=False)
                if not hmac.compare_digest(expected, _read(stream, 32)):
                    raise ValueError('Destination did not confirm the SHA-256.')
                return size, wire_bytes, expected.hex()


def main(argv=None, *, workspace=None):
    from .remote import configured_workspace

    parser = argparse.ArgumentParser(prog='pcremotecommander cli transfer')
    commands = parser.add_subparsers(dest='operation', required=True)
    receiver = commands.add_parser('receive', help='Approve and save one file')
    sender = commands.add_parser('send', help='Approve and send one file')
    for command in (receiver, sender):
        command.add_argument('--bind-ip', required=True)
        command.add_argument('--peer-ip', required=True)
        command.add_argument('--peer-device', required=True)
    receiver.add_argument('--destination', required=True)
    receiver.add_argument('--max-mb', type=int, default=DEFAULT_MB)
    sender.add_argument('--source', required=True)
    sender.add_argument('--port', required=True, type=int)
    args = parser.parse_args(argv)
    receiving = args.operation == 'receive'

    try:
        if not sys.stdin.isatty() or not sys.stdout.isatty():
            raise ValueError('Open an interactive terminal on this computer to approve the transfer.')
        bind_ip, peer_ip = private_ip(args.bind_ip), private_ip(args.peer_ip)
        if bind_ip == peer_ip:
            raise ValueError('Select a different private network address for the other computer.')
        tree = SafeTree(configured_workspace(workspace))
        credential = load_enrolled_credential(tree.root)
        if credential is None:
            raise ValueError('Start PCRC and enroll this workspace before transferring files.')
        enrollment = Enrollment(credential, args.peer_device, receiving)
        path = args.destination if receiving else args.source
        parts(path)
        if receiving:
            if not 1 <= args.max_mb <= (2**63 - 1) // 1_000_000:
                raise ValueError('Choose a positive --max-mb within the supported range.')
            try:
                tree.info(path)
            except FileNotFoundError:
                pass
            else:
                raise ValueError('Destination already exists. Choose a new filename.')
        elif not 1024 <= args.port <= 65535:
            raise ValueError('Use the port shown on the receiving computer.')
        else:
            tree.info(path)
        print(f'Workspace: {tree.root}\nFile: {path!r}\nOther device: {args.peer_device} at {peer_ip}')
        if input(f'Approve this {args.operation}? Type yes: ') != 'yes':
            return 1
        if receiving:
            with listener(bind_ip) as (server, tls, code):
                print(f'Listening on {bind_ip}:{server.getsockname()[1]} for two minutes.')
                print(f'Enter this code privately on the sending PC: {code}', flush=True)
                result = receive(server, tls, code, peer_ip, tree, path, args.max_mb * 1_000_000, enrollment)
        else:
            import warnings
            with warnings.catch_warnings():
                warnings.simplefilter('error', getpass.GetPassWarning)
                code = getpass.getpass('Code from the receiving PC: ').strip()
            result = send(tree, path, bind_ip, peer_ip, args.port, code, enrollment)
        size, wire_bytes, checksum = result
        print(f'Transfer verified. {size:,} file bytes, {wire_bytes:,} payload bytes. SHA-256 {checksum}')
        return 0
    except (OSError, ValueError, EOFError, getpass.GetPassWarning, KeyboardInterrupt) as exc:
        detail = str(exc) if isinstance(exc, ValueError) else 'Could not complete the direct transfer. Check both PCs, the network and the selected paths.'
        print(f'{detail} Inspect the destination before retrying.', file=sys.stderr)
        return 1
