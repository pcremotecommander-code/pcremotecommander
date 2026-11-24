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



@pytest.mark.parametrize(
    "run",
    [
        None,
        [],
        {},
        {"task_id": ["task-1"], "status": "unknown"},
        {"task_id": "task-1", "status": ["unknown"]},
    ],
)
def test_malformed_run_record_returns_safe_state_error(store, run):
    store.save({
        "tasks": {},
        "workflows": {},
        "runs": {"run-1": run},
        "operations": {},
    })

    with pytest.raises(CoordinationError, match="state"):
        store.load()


def test_oversized_persisted_expiry_returns_safe_state_error(store):
    store.save({
        "tasks": {
            "task-1": {
                "id": "task-1",
                "status": "active",
                "resources": ["workspace"],
                "expires_at": 10 ** 400,
                "lease_token": "lease-token",
            },
        },
        "workflows": {},
        "runs": {},
        "operations": {},
    })

    with pytest.raises(CoordinationError, match="expiry"):
        store.load()


def valid_run():
    return {
        "id": "run-1",
        "task_id": "task-1",
        "workflow": {
            "id": "workflow-1",
            "title": "Synthetic workflow",
            "steps": [
                {"action": "open", "target": "http://example.test/"},
                {"action": "click", "target": "#done", "before_url": "http://example.test/"},
            ],
            "status": "published",
            "expected_url": "http://example.test/",
            "expected_text": "Done",
            "version": 1,
        },
        "next_step": 0,
        "status": "ready",
    }


@pytest.mark.parametrize("status", ["succeeded", "complete", "running", ""])
def test_unsupported_run_status_returns_safe_state_error(store, status):
    run = valid_run()
    run["status"] = status
    store.save({
        "tasks": {}, "workflows": {}, "runs": {"run-1": run}, "operations": {},
    })

    with pytest.raises(CoordinationError, match="run"):
        store.load()


@pytest.mark.parametrize(
    "workflow",
    [
        None,
        {},
        {"id": "workflow-1", "title": "Synthetic", "steps": []},
        {
            "id": "workflow-1", "title": "Synthetic",
            "steps": [{"action": "execute", "target": "#done"}],
            "status": "published", "expected_url": "http://example.test/",
            "expected_text": "Done", "version": 1,
        },
        {
            "id": "workflow-1", "title": "Synthetic",
            "steps": [{"action": "click"} , {"action": "click", "target": "#done", "before_url": "http://example.test/"}],
            "status": "published", "expected_url": "http://example.test/",
            "expected_text": "Done", "version": 1,
        },
        {
            "id": "workflow-1", "title": "Synthetic",
            "steps": [{"action": ["click"], "target": "#done"}, {"action": "click", "target": "#done", "before_url": "http://example.test/"}],
            "status": "published", "expected_url": "http://example.test/",
            "expected_text": "Done", "version": 1,
        },
    ],
)
def test_malformed_run_workflow_snapshot_returns_safe_state_error(store, workflow):
    run = valid_run()
    run["workflow"] = workflow
    store.save({
        "tasks": {}, "workflows": {}, "runs": {"run-1": run}, "operations": {},
    })

    with pytest.raises(CoordinationError, match="run"):
        store.load()


@pytest.mark.parametrize("next_step", [True, -1, 2, 1.5, "1"])
def test_invalid_run_step_position_returns_safe_state_error(store, next_step):
    run = valid_run()
    run["next_step"] = next_step
    store.save({
        "tasks": {}, "workflows": {}, "runs": {"run-1": run}, "operations": {},
    })

    with pytest.raises(CoordinationError, match="run"):
        store.load()


def test_valid_run_lifecycle_states_and_terminal_step_position_load(store):
    run = valid_run()
    store.save({
        "tasks": {}, "workflows": {}, "runs": {"run-1": run}, "operations": {},
    })
    assert store.load()["runs"]["run-1"]["status"] == "ready"

    for status in ("unknown", "passed", "failed", "abandoned_after_review"):
        run["status"] = status
        run["next_step"] = 2 if status in {"passed", "failed"} else 1
        store.save({
            "tasks": {}, "workflows": {}, "runs": {"run-1": run}, "operations": {},
        })
        assert store.load()["runs"]["run-1"]["status"] == status
