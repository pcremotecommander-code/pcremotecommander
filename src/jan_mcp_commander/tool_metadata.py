"""Directory-facing MCP tool metadata shared by the base and control catalogs."""


def directory_tool(server, *, annotations):
    """Register a tool with a human-readable title and its safety annotations."""
    def register(function):
        title = function.__name__.removeprefix('jan_').replace('_', ' ').capitalize()
        return server.tool(title=title, annotations=annotations)(function)

    return register
