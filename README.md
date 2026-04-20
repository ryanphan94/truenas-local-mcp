# TrueNAS Local MCP

Small stdio MCP server for your local TrueNAS box.

## What it does

- Reads `TRUENAS_*` settings from normal environment variables
- On macOS, prefers fresh `launchctl getenv` values over stale app process env
- Authenticates with `auth.login_with_api_key`
- Exposes a few read-only tools plus one guarded raw-call tool
- Includes a Dockerfile so it can be packaged as a Docker MCP Registry local server

## Tools

- `system_info`
- `alert_list`
- `pool_query`
- `dataset_query`
- `disk_query`
- `app_query`
- `replication_query`
- `snapshot_query`
- `truenas_call`

`truenas_call` blocks obviously mutating methods unless you set `TRUENAS_ALLOW_MUTATIONS=1`.

## Environment

Recommended for your current setup:

```bash
launchctl setenv TRUENAS_URL 'https://truenas.local'
launchctl setenv TRUENAS_API_KEY 'YOUR_KEY'
launchctl setenv TRUENAS_TLS_INSECURE '1'
launchctl unsetenv TRUENAS_ALLOW_INSECURE
```

Only use plain HTTP if you truly mean it:

```bash
launchctl setenv TRUENAS_URL 'http://truenas.local'
launchctl setenv TRUENAS_API_KEY 'YOUR_KEY'
launchctl setenv TRUENAS_ALLOW_INSECURE '1'
launchctl unsetenv TRUENAS_TLS_INSECURE
```

## Run locally

```bash
cd /path/to/truenas-local-mcp
node src/index.mjs
```

## Build container

```bash
cd /path/to/truenas-local-mcp
docker build -t truenas-local-mcp .
```

Run it with environment variables passed through:

```bash
docker run --rm -i \
  -e TRUENAS_URL='https://truenas.local' \
  -e TRUENAS_API_KEY \
  -e TRUENAS_TLS_INSECURE='1' \
  truenas-local-mcp
```

## Codex config snippet

Add this to `~/.codex/config.toml` when you want to register it:

```toml
[mcp_servers.truenas_local]
command = "node"
args = ["/absolute/path/to/truenas-local-mcp/src/index.mjs"]
```

## Docker MCP Registry notes

- Docker's registry wants a containerized local server for this kind of project.
- You need a public GitHub repository with this `Dockerfile` at the root.
- You then add a `servers/<name>/server.yaml` entry in `docker/mcp-registry`.
- This repo now includes a `tools.json` manifest so Docker's `task build -- --tools ...` flow does not need live TrueNAS credentials just to enumerate tools.
- A draft registry entry is included here as `registry-server.yaml.example`.

## Registry-ready checklist

- Replace the placeholder `source.commit` value in `registry-server.yaml.example`.
- Copy `registry-server.yaml.example` into `docker/mcp-registry/servers/truenas-local/server.yaml`.
- Keep `tools.json` next to that `server.yaml` in the registry repo.
- Test with Docker's local catalog flow before opening the PR.

## Notes

- This server intentionally reconnects per tool call. It is simpler and more robust for a local LAN box.
- `TRUENAS_TLS_INSECURE=1` keeps TLS encryption but skips certificate verification.
- The TrueNAS docs warn against using API keys over insecure HTTP transport.
