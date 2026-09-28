# Etchv MCP server

A local stdio [Model Context Protocol](https://modelcontextprotocol.io) server
that lets AI assistants watermark and detect images, PDFs and videos with
[Etchv](https://etchv.com).

## Requirements

- Node.js 24 or later
- An Etchv API key with only the [scopes](#tools) you need
- An existing directory for input and output files

## Configuration

| Variable | Required | Description |
| --- | --- | --- |
| `ETCHV_API_KEY` | Yes | Etchv API key. Keep it in your client's secret or env config, never in chat. |
| `ETCHV_FILES_ROOT` | Yes | Absolute path of an existing directory. All input and output files must be inside it. |
| `ETCHV_API_BASE_URL` | No | API origin. Defaults to `https://api.etchv.com`. |

### Claude Code

```sh
claude mcp add etchv --scope user \
  -e ETCHV_API_KEY="$ETCHV_API_KEY" \
  -e ETCHV_FILES_ROOT="$HOME/etchv-media" \
  -- npx -y @etchv-labs/mcp-server@1
```

### Claude Desktop, Cursor and other `mcpServers` clients

Add this to the client's MCP config (for example `claude_desktop_config.json`
or `~/.cursor/mcp.json`) and restart it:

```json
{
  "mcpServers": {
    "etchv": {
      "command": "npx",
      "args": ["-y", "@etchv-labs/mcp-server@1"],
      "env": {
        "ETCHV_API_KEY": "YOUR_ETCHV_API_KEY",
        "ETCHV_FILES_ROOT": "/absolute/path/to/etchv-media"
      }
    }
  }
}
```

Then ask the assistant to run `check_api_key` to confirm the connection.

## Tools

| Tool | What it does | Key scope |
| --- | --- | --- |
| `check_api_key` | Show organization ID, key ID and scopes; no credits | Any valid key |
| `watermark_media` | Watermark a local file, sync or async; spends credits | `watermarks:embed` |
| `detect_media` | Detect a watermark, sync or async; uses credits | `watermarks:detect` |
| `get_job`, `get_job_result` | Read job status; collect a finished result | Matching embed/detect scope |
| `list_assets`, `get_asset`, `download_asset` | List, inspect and download assets | `assets:read` |
| `update_asset` | Rename or replace metadata (version-checked) | `assets:write` |
| `delete_asset` | Delete an asset | `assets:delete`, owner/admin |
| `list_storage_destinations`, `list_storage_deliveries`, `get_storage_delivery` | Inspect customer storage | `storage:read` |
| `verify_storage_destination`, `store_asset`, `retry_storage_delivery` | Test a bucket; deliver or retry a result | `storage:write`, owner/admin |
| `list_webhooks`, `list_webhook_deliveries` | Inspect webhook endpoints and deliveries | `webhooks:read` |
| `redeliver_webhook` | Resend an existing event | `webhooks:write`, owner/admin |

Submissions require a stable `idempotency_key`; reuse it when retrying so you
are not charged twice. Image uploads are limited to 50 MiB and PDF and video
uploads to 20 MiB. Storage destinations and webhook endpoints are created in the
dashboard, not through this server.

## Security

- The API key is read only from `ETCHV_API_KEY`, sent only to the configured
  origin, and never appears in tool arguments, results, errors or logs.
- File access is confined to `ETCHV_FILES_ROOT`: traversal and symlinks are
  rejected, and existing files are never overwritten.
- Only HTTPS origins are accepted (HTTP for localhost only), and redirects are
  never followed.
- API responses, asset names and metadata are treated as untrusted data, never
  instructions.

## Links

- Guide: https://etchv.com/docs/mcp
- API reference: https://etchv.com/docs
- Issues: https://github.com/etchv-labs/mcp-server/issues
- Support: hello@etchv.com

Questions or bug reports: open an issue here or email hello@etchv.com.

## License

[MIT](LICENSE)
