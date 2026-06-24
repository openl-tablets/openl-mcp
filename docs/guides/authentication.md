# Authentication Guide

This guide covers authentication for the OpenL MCP Server. The server authenticates with a **Personal Access Token (PAT)**. Authentication is optional — an OpenL Studio in single-user mode accepts unauthenticated requests.

## Table of Contents
- [Authentication Method](#authentication-method)
- [Setup](#setup)
- [Personal Access Token Authentication](#personal-access-token-authentication)
- [Security Best Practices](#security-best-practices)
- [Troubleshooting](#troubleshooting)

## Authentication Method

The MCP server authenticates with a Personal Access Token (PAT) — a user-generated token created in the OpenL Studio UI. When no token is configured, requests are sent without an `Authorization` header (OpenL Studio single-user mode).

## Setup

The token lives **with the client**, never inside the server. How you pass it
depends on the transport:

1. **stdio** (default — Claude Code, Claude Desktop, Cursor, VS Code) — set
   `OPENL_PERSONAL_ACCESS_TOKEN` in the `env` block of the client's MCP config.
2. **HTTP** (`--http`, a shared server) — send it on the `Authorization` header
   when connecting.

### stdio transport (per client)

Put the token in the `env` block that launches `npx` (or Docker). Example for Cursor
(`~/.cursor/mcp.json`):

```json
{
  "mcpServers": {
    "openl": {
      "command": "npx",
      "args": ["-y", "openl-mcp-server", "http://localhost:8080"],
      "env": {
        "OPENL_PERSONAL_ACCESS_TOKEN": "<your-pat-token>"
      }
    }
  }
}
```

> The base URL is the positional argument (`http://localhost:8080`). You can instead
> set `OPENL_BASE_URL` in `env`; the positional wins if both are present. Omit the
> `env` block entirely for a single-user Studio.

Per-client configs (Claude Code, Claude Desktop, VS Code, and the Docker form) are in
the [MCP Connection Guide](../setup/mcp-connection-guide.md).

### HTTP transport (shared server)

When a client connects to a server started with `--http`, the base URL always comes
from the **server** (its positional `<url>` / `OPENL_BASE_URL`); the client supplies
only the token, on the header:

```text
Authorization: Token <your-token>
```

`Bearer <your-token>` is also accepted and converted to `Token` for the OpenL API.

⚠️ **Never bake the token into the server** — not in `compose.yaml`, host environment
variables, the Git repository, or logs. The server reads only the OpenL **base URL**;
the **token** always comes from the client (its `env` for stdio, or the `Authorization`
header for HTTP).

For complete configuration examples, see [MCP Connection Guide](../setup/mcp-connection-guide.md).

## Personal Access Token Authentication

Personal Access Token (PAT) authentication uses user-generated tokens created in the OpenL Studio UI. PATs provide a secure way to authenticate API requests without using passwords.

### Features

- ✅ **User-Generated** - Created and managed in OpenL Studio UI
- ✅ **Token Format** - `openl_pat_<publicId>.<secret>`
- ✅ **Expiration Support** - Optional expiration dates for enhanced security
- ✅ **User Isolation** - Each user manages their own tokens
- ✅ **OAuth2/SAML Only** - Available only when OpenL Studio is configured for OAuth2 or SAML authentication

### Prerequisites

- OpenL Studio must be configured with OAuth2 or SAML authentication mode
- You must have a valid OAuth2/SAML session to create PATs
- PATs cannot be used to manage other PATs (enforced by security)

### Creating a Personal Access Token

1. Log in to OpenL Studio
2. Navigate to **User Settings** → **Personal Access Tokens**
3. Click **Create Token**
4. Provide a name and optional expiration date
5. Copy the token immediately (it's shown only once)

**Token Format:**
```
<your-pat-token>
```

### Configuration

**Environment Variables:**
```bash
OPENL_BASE_URL=https://openl.example.com
OPENL_PERSONAL_ACCESS_TOKEN=<your-pat-token>
```

**Claude Desktop / Cursor Config:**
```json
{
  "mcpServers": {
    "openl": {
      "command": "npx",
      "args": ["-y", "openl-mcp-server", "https://openl.example.com"],
      "env": {
        "OPENL_PERSONAL_ACCESS_TOKEN": "<your-pat-token>"
      }
    }
  }
}
```

### Use Cases

- **MCP Server Integration** - Perfect for Cursor/Claude Desktop MCP servers
- **CI/CD Pipelines** - Automated deployments and testing
- **API Scripts** - Command-line tools and automation
- **Service-to-Service** - Microservice communication
- **Development** - Local development

### Security Considerations

- ✅ **Revocable** - Tokens can be revoked from the UI without changing your password
- ✅ **Expiration Support** - Optional expiration dates
- ✅ **User-Scoped** - Tokens are tied to the user who created them
- ⚠️ **Token Storage** - Store tokens securely (environment variables, secret managers)
- ⚠️ **Token Exposure** - Never commit tokens to version control
- ✅ **Use HTTPS Always** - Required for production

### Token Management

- **View Tokens**: List all your PATs in the UI
- **Delete Tokens**: Revoke access by deleting tokens
- **Expiration**: Check token expiration dates
- **Usage**: Use `Authorization: Token <token>` header format

**Important**: The full token value is shown only once when created. Store it securely - it cannot be retrieved later.

## Security Best Practices

### General

1. **Always Use HTTPS** - Never send a token over HTTP
2. **Rotate Tokens** - Regularly rotate tokens and revoke unused ones
3. **Least Privilege** - Use minimum required scopes/permissions
4. **Separate Environments** - Different tokens for dev/staging/production
5. **Monitor Access** - Log and monitor authentication attempts

### Configuration Management

1. **Environment Variables**
   ```bash
   # Good: Use env files
   cp .env.example .env
   # Edit .env with actual values
   ```

2. **Secret Managers**
   ```bash
   # Good: Fetch from secret manager
   export OPENL_PERSONAL_ACCESS_TOKEN=$(vault read secret/openl/pat)
   ```

3. **Version Control**
   ```gitignore
   # .gitignore
   .env
   .env.local
   .env.*.local
   ```

## Troubleshooting

### Authentication Failed

**Symptoms:**
```
OpenL Studio API error (401): Authentication required
```

**Solutions:**
1. Verify the PAT is correct and has not expired
2. Confirm the token starts with `openl_pat_`
3. Ensure your user has the required permissions
4. Verify OpenL Studio is configured for OAuth2 or SAML (PATs are available only in those modes)

### Connection Timeout

**Symptoms:**
```
Error: timeout of 30000ms exceeded
```

**Solutions:**
1. Increase timeout: `OPENL_TIMEOUT=60000`
2. Check network connectivity
3. Verify OpenL Studio is running
4. Check firewall rules

### SSL/TLS Errors

**Symptoms:**
```
Error: unable to verify the first certificate
```

**Solutions:**
1. Ensure valid SSL certificate
2. Update CA certificates
3. Check certificate chain
4. For development only: Configure to accept self-signed certs

## Environment Variable Reference

### Common
```bash
OPENL_BASE_URL    # OpenL Studio API base URL
OPENL_TIMEOUT     # Request timeout in milliseconds
```

### Personal Access Token
```bash
OPENL_PERSONAL_ACCESS_TOKEN  # Personal Access Token (format: openl_pat_<publicId>.<secret>)
```

## Examples

### Single-user mode (no token)
```bash
npx -y openl-mcp-server http://localhost:8080
```

### Production with a Personal Access Token
```bash
export OPENL_PERSONAL_ACCESS_TOKEN=$(vault read -field=token secret/openl/prod/pat)
export OPENL_TIMEOUT=60000
npx -y openl-mcp-server https://openl-prod.example.com
```

## Related Documentation

- [MCP Connection Guide](../setup/mcp-connection-guide.md) - Complete connection setup guide
- [Troubleshooting Guide](troubleshooting.md) - Common authentication issues
- [Quick Start Guide](../getting-started/quick-start.md) - Quick setup instructions
- [Usage Examples](examples.md) - Examples using authentication

## Resources

- [OpenL Studio Documentation](https://openl-tablets.org/)
- [MCP Server README](../../README.md)
- [Testing Guide](../development/testing.md)
