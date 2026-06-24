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

**IMPORTANT**: Authentication tokens **MUST NOT** be set in Docker configuration or server environment variables for the HTTP transport. They should be provided **only** in the MCP client configuration (Cursor / Claude Desktop) or via the HTTP `Authorization` header.

### How It Works

The MCP server supports two modes of operation:

1. **stdio transport** (for Cursor/Claude Desktop) - authentication is set in the MCP client configuration via environment variables in the config file
2. **HTTP transport** (for Docker) - authentication is passed via the HTTP Authorization header when connecting

### For Cursor IDE or Claude Desktop (stdio transport)

Configure authentication in the MCP client configuration file:

**Example for Cursor:**
```json
{
  "mcpServers": {
    "openl-mcp-server": {
      "command": "node",
      "args": ["<path-to-project>/dist/index.js", "http://localhost:8080"],
      "env": {
        "OPENL_PERSONAL_ACCESS_TOKEN": "<your-pat-token>"
      }
    }
  }
}
```

**Example for Claude Desktop** (macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`):
```json
{
  "mcpServers": {
    "openl-mcp-server": {
      "command": "node",
      "args": ["<path-to-project>/dist/index.js", "http://localhost:8080"],
      "env": {
        "OPENL_PERSONAL_ACCESS_TOKEN": "<your-pat-token>"
      }
    }
  }
}
```

> The base URL is passed as the positional argument (`args: [..., "http://localhost:8080"]`). You can instead keep it in `env` as `OPENL_BASE_URL`; the positional takes precedence if both are set. The `env` block here carries only the (optional) auth token.

### For HTTP Transport (Docker)

When connecting via HTTP, the base URL always comes from the **server** configuration
(`OPENL_BASE_URL`). The client supplies only the authentication token — a base URL sent
by the client is ignored.

**Recommended — `Authorization` header:**

```text
Authorization: Token <your-token>
```

The `Bearer <your-token>` scheme is also accepted and automatically converted to `Token`
for the OpenL API.

### Docker Configuration

In Docker configuration (`compose.yaml`), **only** the base URL is set:

```yaml
environment:
  PORT: 3000
  OPENL_BASE_URL: http://studio:8080
  NODE_ENV: production
  # Authentication is NOT set here!
```

⚠️ **Security**: Never set tokens or other secrets in:
- Docker compose files
- Host environment variables (for Docker)
- Git repository
- Logs

✅ **Correct**: Set the token only in:
- MCP client configuration files (Cursor/Claude Desktop)
- The `Authorization` header when connecting via HTTP

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
    "openl-studio": {
      "command": "node",
      "args": ["<path-to-project>/dist/index.js", "https://openl.example.com"],
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

### Local Development (single-user mode, no token)
```bash
export OPENL_BASE_URL=http://localhost:8080
npm start
```

### Production with Personal Access Token
```bash
export OPENL_BASE_URL=https://openl-prod.example.com
export OPENL_PERSONAL_ACCESS_TOKEN=$(vault read -field=token secret/openl/prod/pat)
export OPENL_TIMEOUT=60000
npm start
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
