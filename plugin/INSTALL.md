# Installing the semidex Plugin for Claude Desktop (Cowork)

This installs semidex as a native Claude Desktop plugin, making the `qdrant_*` MCP tools
available in all Cowork sessions automatically.

## Prerequisites

- Node.js >= 18
- Qdrant instance (local or cloud) with semidex collections already indexed
- semidex repo cloned locally

## Steps

### 1. Find your Cowork session directory

Open PowerShell:

```powershell
$base = "$env:APPDATA\Claude\local-agent-mode-sessions"
Get-ChildItem $base | Sort-Object LastWriteTime -Descending | Select-Object -First 3 Name, LastWriteTime
```

Note the most recent directory name — it is your session ID (e.g. `3f74903d-...`).
Inside it there is a sub-directory (space ID). The rpm folder is:

```
%APPDATA%\Claude\local-agent-mode-sessions\<session-id>\<space-id>\rpm\
```

### 2. Create the plugin folder

```powershell
$rpm = "$env:APPDATA\Claude\local-agent-mode-sessions\<session-id>\<space-id>\rpm"
$plugin = "$rpm\plugin_semidex"
New-Item -ItemType Directory -Force "$plugin\.claude-plugin"
New-Item -ItemType Directory -Force "$plugin\skills\semidex"
```

### 3. Copy plugin files

From the semidex repo root:

```powershell
$repo = "C:\path\to\semidex"
Copy-Item "$repo\plugin\.claude-plugin\plugin.json" "$plugin\.claude-plugin\plugin.json"
Copy-Item "$repo\plugin\skills\semidex\SKILL.md"   "$plugin\skills\semidex\SKILL.md"
```

### 4. Create `.mcp.json`

Copy the template and fill in your values:

```powershell
Copy-Item "$repo\plugin\.mcp.json.template" "$plugin\.mcp.json"
```

Then edit `$plugin\.mcp.json`:

- Replace `SEMIDEX_PATH` with the absolute path to this repo (e.g. `C:\\Users\\you\\Documents\\Projects\\semidex`)
- Replace `YOUR_QDRANT_URL` with your Qdrant URL (e.g. `http://localhost:6333` or cloud URL)
- Replace `YOUR_QDRANT_KEY` with your Qdrant API key (omit the `QDRANT_KEY` line entirely for local Qdrant without auth)

### 5. Register in manifest

Add to `$rpm\manifest.json` inside the `"plugins"` array:

```json
{
  "id": "plugin_semidex",
  "name": "semidex",
  "updatedAt": "2026-01-01T00:00:00.000000Z",
  "marketplaceId": "local",
  "marketplaceName": "Local",
  "installedBy": "user",
  "installationPreference": "available"
}
```

### 6. Restart Claude Desktop

Close and reopen Claude Desktop. The semidex plugin will appear in the plugin list,
and `qdrant_*` tools will be available in all Cowork sessions.

## Updating

When `SKILL.md` changes (new semidex features), re-copy it:

```powershell
Copy-Item "$repo\plugin\skills\semidex\SKILL.md" "$plugin\skills\semidex\SKILL.md"
```

No restart required for skill content changes — Claude reads them at invocation time.

When `.mcp.json` changes (new env vars or server path), restart Claude Desktop after updating.
