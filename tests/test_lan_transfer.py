from concurrent.futures import ThreadPoolExecutor
import hashlib
import os
import zlib

import pytest

from jan_mcp_commander import lan_transfer as transfer
from jan_mcp_commander.safe_fs import SafeTree


class TestAuthority:
    __test__ = False

    def __init__(self, role, revoke_at_commit=False):
        self.role = role
        self.revoke_at_commit = revoke_at_commit
        self.verifications = 0

    def sign(self, session, timestamp):
        return self.role * 86

    def verify(self, session, timestamp, sender, receiver):
        assert sender == b's' * 86 and receiver == b'r' * 86
        self.verifications += 1
        if self.revoke_at_commit and self.verifications == 2:
            raise ValueError('Device was revoked')


@pytest.mark.parametrize('case', ['120mb', 'higher-limit', 'binary', 'empty', 'limit', 'denied', 'revoked', 'exists', 'wrong-pin', 'wrong-code', 'corrupt'])
def test_direct_tls_transfer_and_failures(tmp_path, monkeypatch, request, case):
    source = tmp_path / 'source'
    destination = tmp_path / 'destination'
    source.mkdir()
    destination.mkdir()
    large_cases = {'120mb': 120_000_000, 'higher-limit': 121_000_000, 'limit': 120_000_001}
    size = large_cases.get(case, 0 if case == 'empty' else 8192)
    test_file = source / 'sample.bin'
    output = destination / 'received.bin'
    request.addfinalizer(lambda: test_file.unlink(missing_ok=True))
    request.addfinalizer(lambda: output.unlink(missing_ok=True))
    if case in large_cases:
        with test_file.open('wb') as file:
            file.truncate(size)
    else:
        test_file.write_bytes(os.urandom(size))
    if case == 'exists':
        output.write_bytes(b'original')
    if case == 'corrupt':
        monkeypatch.setattr(transfer, '_digest', lambda fd, count: bytes(32))
    maximum = 121_000_000 if case == 'higher-limit' else 120_000_000
    sender = TestAuthority(b's')
    receiver = TestAuthority(b'r', revoke_at_commit=case == 'revoked')
    if case == 'denied':
        def deny(*args):
            raise ValueError('Account denied')
        sender.verify = deny
    ip = '127.0.0.1'
    with transfer.listener(ip) as (server, tls, code), ThreadPoolExecutor() as pool:
        future = pool.submit(transfer.receive, server, tls, code, ip, SafeTree(destination), 'received.bin', maximum, receiver)
        port = server.getsockname()[1]
        if case in ('120mb', 'higher-limit', 'binary', 'empty'):
            sent = transfer.send(SafeTree(source), 'sample.bin', ip, ip, port, code, sender)
            assert sent == future.result(timeout=5)
            with output.open('rb') as file:
                assert hashlib.file_digest(file, 'sha256').hexdigest() == sent[2]
            assert output.stat().st_size == sent[0] == size
            assert sender.verifications == receiver.verifications == 2
            if case in large_cases:
                assert sent[1] < 1_000_000
            else:
                assert sent[1] == size
            return
        if case == 'wrong-pin':
            code = ('0' if code[0] != '0' else '1') + code[1:]
        if case == 'wrong-code':
            code = code[:-1] + ('0' if code[-1] != '0' else '1')
        with pytest.raises((OSError, ValueError)):
            transfer.send(SafeTree(source), 'sample.bin', ip, ip, port, code, sender)
        with pytest.raises((OSError, ValueError)):
            future.result(timeout=5)
    assert list(destination.iterdir()) == ([output] if case == 'exists' else [])
    if case == 'exists':
        assert output.read_bytes() == b'original'


def test_transfer_rejects_unsafe_paths_and_addresses(tmp_path):
    tree = SafeTree(tmp_path)
    for path in ('../outside', '.env', '.ssh/key'):
        with pytest.raises(ValueError):
            with tree.open_read(path):
                pytest.fail('Protected source was opened')
        with pytest.raises(ValueError):
            tree.write_chunks(path, iter((b'blocked',)))
    for address in ('127.0.0.1', '8.8.8.8', '169.254.1.2', '::1'):
        with pytest.raises(ValueError):
            transfer.private_ip(address)
    assert transfer.private_ip('192.168.1.12') == '192.168.1.12'
    with pytest.raises(ValueError):
        transfer._inflate(zlib.compress(b'x' * 500), 100)


def test_transfer_cli_help_and_noninteractive_denial(capsys):
    from jan_mcp_commander import cli

    with pytest.raises(SystemExit) as result:
        cli.main(['transfer', 'receive', '--help'])
    assert result.value.code == 0
    assert '--max-mb' in capsys.readouterr().out
    assert cli.main(['transfer', 'receive', '--bind-ip', '192.168.1.1', '--peer-ip', '192.168.1.2',
                     '--peer-device', '11000000-0000-4000-8000-000000000001', '--destination', 'test']) == 1
    assert 'interactive terminal' in capsys.readouterr().err
