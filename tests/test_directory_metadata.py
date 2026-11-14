"""The public MCP catalog exposes the metadata directory reviewers inspect."""

import asyncio

from jan_mcp_commander.control import ControlCommander
from jan_mcp_commander.portable import PortableCommander
from jan_mcp_commander.server import build_server


def _check_catalog(commander):
    tools = asyncio.run(build_server(commander).list_tools())
    assert tools
    for tool in tools:
        assert tool.title and tool.title != tool.name
        assert tool.description
        assert tool.annotations is not None
        if tool.name in {'jan_status', 'jan_list_files', 'jan_read_text', 'jan_search_text', 'jan_process_output'}:
            assert tool.annotations.read_only_hint is True
        else:
            assert tool.annotations.read_only_hint is not None
            if not tool.annotations.read_only_hint:
                assert tool.annotations.destructive_hint is not None


def test_read_only_directory_metadata(tmp_path, monkeypatch):
    work = tmp_path / 'work'
    work.mkdir()
    monkeypatch.setenv('JAN_MCP_STATE_DIR', str(tmp_path / 'state'))
    _check_catalog(PortableCommander(work, tmp_path / 'audit.jsonl'))


def test_control_directory_metadata(tmp_path, monkeypatch):
    work = tmp_path / 'work'
    work.mkdir()
    monkeypatch.setenv('JAN_MCP_STATE_DIR', str(tmp_path / 'state'))
    commander = ControlCommander(work, enabled={'files', 'commands', 'browser', 'desktop'})
    try:
        _check_catalog(commander)
    finally:
        commander.close_control()
