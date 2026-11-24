import pytest

from jan_mcp_commander.control import ControlCommander
from jan_mcp_commander.coordination import Coordination, CoordinationError


@pytest.fixture
def store(tmp_path, monkeypatch):
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    monkeypatch.setenv("JAN_MCP_STATE_DIR", str(tmp_path / "private"))
    commander = ControlCommander(workspace, enabled={"files", "commands", "browser", "desktop"})
    try:
        yield Coordination(commander)
    finally:
        commander.close_control()


@pytest.mark.parametrize(
    "state",
    [
        [],
        None,
        {"tasks": [], "workflows": {}, "runs": {}, "operations": {}},
        {"tasks": {}, "workflows": [], "runs": {}, "operations": {}},
        {"tasks": {}, "workflows": {}, "runs": [], "operations": {}},
        {"tasks": {}, "workflows": {}, "runs": {}, "operations": []},
        {"workflows": {}, "runs": {}, "operations": {}},
    ],
)
def test_malformed_coordination_root_fails_closed(store, state):
    store.save(state)

    with pytest.raises(CoordinationError, match="state"):
        store.load()


@pytest.mark.parametrize(
    "task",
    [
        {},
        {"id": "broken", "status": "active"},
        {"id": "broken", "status": "active", "resources": "workspace"},
    ],
)
def test_malformed_task_record_returns_safe_state_error(store, task):
    store.save({
        "tasks": {"broken": task},
        "workflows": {},
        "runs": {},
        "operations": {},
    })

    with pytest.raises(CoordinationError, match="state"):
        store.task("list")


def test_malformed_active_operation_is_never_released_by_recovery(store):
    operation = {
        "id": "malformed-operation",
        "state": "active",
        "resources": ["file:../outside"],
        "lock_resources": ["workspace"],
    }
    store.save({
        "tasks": {},
        "workflows": {},
        "runs": {},
        "operations": {"malformed-operation": operation},
    })

    result = store.recover_operations()

    assert result["changed"] == ["malformed-operation"]
    assert result["recovered"] == []
    assert store.load()["operations"]["malformed-operation"] == operation
