"""MCP v2 stdio server. No network listener in Stage 1."""
import os
from pathlib import Path
from mcp.server import MCPServer
from .portable import PortableCommander
from mcp.types import ToolAnnotations
from .errors import tool_errors
from .tool_metadata import directory_tool


def build_server(commander: PortableCommander) -> MCPServer:
    commander._transport = getattr(commander, '_transport', 'stdio')
    server = MCPServer("PC Remote Commander")

    @directory_tool(server, annotations=ToolAnnotations(readOnlyHint=True, openWorldHint=False))
    @tool_errors(commander)
    def jan_task_state() -> dict:
        """List bounded local shared tasks and unresolved operation IDs without exposing tokens, paths or command text."""
        from .coordination import coordinator
        return coordinator(commander).task('list')

    @directory_tool(server, annotations=ToolAnnotations(readOnlyHint=True, openWorldHint=False))
    @tool_errors(commander)
    def jan_workflow_state(kind: str = 'list', identifier: str = '') -> dict:
        """Inspect local workflow drafts, published steps and run status without execution."""
        from .browser_teaching import read_workflows
        return read_workflows(commander, kind, identifier)

    @directory_tool(server, annotations=ToolAnnotations(readOnlyHint=True, openWorldHint=False))
    @tool_errors(commander)
    def jan_status() -> dict:
        """Report PC Remote Commander version, workspace and local-only connection state."""
        return commander.status()

    @directory_tool(server, annotations=ToolAnnotations(readOnlyHint=True, openWorldHint=False))
    @tool_errors(commander)
    def jan_list_files(path: str = ".") -> dict:
        """List files inside the explicitly authorized workspace (relative path only)."""
        return commander.list_files(path)

    @directory_tool(server, annotations=ToolAnnotations(readOnlyHint=True, openWorldHint=False))
    @tool_errors(commander)
    def jan_read_text(path: str) -> dict:
        """Read UTF-8 text files up to 64 KiB inside the authorized workspace."""
        return commander.read_text(path)

    @directory_tool(server, annotations=ToolAnnotations(readOnlyHint=True, openWorldHint=False))
    @tool_errors(commander)
    def jan_diagnostic(name: str) -> dict:
        """Run a predefined read-only diagnostic: python_version, uname. Git execution is disabled."""
        return commander.diagnostic(name)

    @directory_tool(server, annotations=ToolAnnotations(readOnlyHint=True, openWorldHint=False))
    @tool_errors(commander)
    def jan_run_profile(name: str, timeout_seconds: int = 5) -> dict:
        """Run a fixed, allowlisted local command profile with timeout and output limits.

        Profiles: list_workspace, disk_usage. Git execution is disabled. Arbitrary commands are disabled.
        """
        return commander.run_profile(name, timeout_seconds)

    @directory_tool(server, annotations=ToolAnnotations(readOnlyHint=True, openWorldHint=False))
    @tool_errors(commander)
    def jan_file_info(path: str) -> dict:
        """Show file metadata inside the approved workspace."""
        return commander.file_info(path)

    @directory_tool(server, annotations=ToolAnnotations(readOnlyHint=True, openWorldHint=False))
    @tool_errors(commander)
    def jan_find_files(term: str, max_results: int = 50, path: str = '.') -> dict:
        """Find matching filenames inside the approved workspace."""
        return commander.find_files(term, max_results, path)

    @directory_tool(server, annotations=ToolAnnotations(readOnlyHint=False, destructiveHint=True, openWorldHint=False))
    @tool_errors(commander)
    def jan_write_text(path: str, content: str, overwrite: bool = False) -> dict:
        """Create a bounded UTF-8 text file; overwrite must be explicitly requested and creates a backup."""
        return commander.write_text(path, content, overwrite)

    @directory_tool(server, annotations=ToolAnnotations(readOnlyHint=False, destructiveHint=True, openWorldHint=False))
    @tool_errors(commander)
    def jan_restore_backup(backup_id: str) -> dict:
        """Restore one backed-up workspace file by its backup ID."""
        return commander.restore_backup(backup_id)

    @directory_tool(server, annotations=ToolAnnotations(readOnlyHint=False, destructiveHint=True, openWorldHint=False))
    @tool_errors(commander)
    def jan_start_session(profile: str) -> dict:
        """Start an approved predefined command profile as a bounded session (no shell)."""
        return commander.start_session(profile)

    @directory_tool(server, annotations=ToolAnnotations(readOnlyHint=True, openWorldHint=False))
    @tool_errors(commander)
    def jan_session_output(session_id: str) -> dict:
        """Get output and state for a session started by this server."""
        return commander.session_output(session_id)

    @directory_tool(server, annotations=ToolAnnotations(readOnlyHint=True, openWorldHint=False))
    @tool_errors(commander)
    def jan_list_sessions() -> dict:
        """List sessions owned by this server."""
        return commander.list_sessions()

    @directory_tool(server, annotations=ToolAnnotations(readOnlyHint=False, destructiveHint=True, openWorldHint=False))
    @tool_errors(commander)
    def jan_stop_session(session_id: str) -> dict:
        """Terminate one session owned by this server."""
        return commander.stop_session(session_id)

    @directory_tool(server, annotations=ToolAnnotations(readOnlyHint=True, openWorldHint=False))
    @tool_errors(commander)
    def jan_skills(skill: str | None = None) -> dict:
        """List advisory PCRC workflows; selection never runs tools or grants permissions."""
        return commander.skill_catalog(skill)

    @directory_tool(server, annotations=ToolAnnotations(readOnlyHint=True, openWorldHint=False))
    @tool_errors(commander)
    def jan_route_skill(request: str, skill: str | None = None) -> dict:
        """Suggest a supported workflow; explicit skill overrides rules; ambiguous requests require clarification. No execution or automatic logging."""
        return commander.route_skill(request, skill)

    @directory_tool(server, annotations=ToolAnnotations(readOnlyHint=True, openWorldHint=False))
    @tool_errors(commander)
    def jan_skill_guide() -> dict:
        """Read packaged PCRC instructions. This does not install a skill into ChatGPT or another host."""
        return commander.skill_guide()

    @directory_tool(server, annotations=ToolAnnotations(readOnlyHint=True, openWorldHint=False))
    @tool_errors(commander)
    def jan_feedback_status() -> dict:
        """Report optional local metadata-log counts and ML data limitations; never returns raw requests or commands."""
        return commander.feedback_status()

    # The default server keeps its original tool set. Control tools are registered
    # only after an operator has selected capabilities locally.
    from .control import ControlCommander, register_control_tools
    if isinstance(commander, ControlCommander):
        register_control_tools(server, commander)

    return server


def main() -> None:
    workspace = os.environ.get("JAN_MCP_WORKSPACE")
    if not workspace:
        raise SystemExit("Configure an existing approved PCRC workspace before starting the local server")
    server = build_server(PortableCommander(Path(workspace)))
    server.run()


if __name__ == "__main__":
    main()
