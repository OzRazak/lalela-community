# Connecting Lalela to Claude Desktop or Cursor (MCP)

Lalela includes a local **MCP server**, `lalela-mcp`, that lets MCP clients
read your meetings. You can then ask, for example, "summarise my meetings with
Acme this month" or "what action items are assigned to me?", answered from your
own local Lalela data.

It reads the same local database the app writes. Nothing is sent anywhere
except to the AI client you connect, and access is read-only.

## Tools

- `search_meetings(query)`: full-text search across titles, transcripts,
  summaries and notes
- `list_meetings()`: recent meetings with their ids
- `get_meeting(id)`: full summary, notes and transcript
- `list_projects()`: your projects

## Build it

```sh
cd apps/desktop/src-tauri
cargo build --release --bin lalela-mcp
```

`scripts/bundle-mac.sh` also copies it into the app bundle, at
`Lalela Community.app/Contents/MacOS/lalela-mcp`.

## Claude Desktop

Edit `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "lalela": {
      "command": "/Applications/Lalela Community.app/Contents/MacOS/lalela-mcp"
    }
  }
}
```

Restart Claude Desktop; Lalela's tools appear in the tools menu.

## Cursor

Add the same command under Settings → MCP → Add new server.

## Notes

- By default the server opens
  `~/Library/Application Support/io.github.ozrazak.lalela-community/lalela.db`.
  Set `LALELA_DB` to point it somewhere else (for example a test data folder
  made with `LALELA_DATA_DIR`).
