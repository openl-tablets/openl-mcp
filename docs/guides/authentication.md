# Authentication Guide

This guide covers the authentication methods supported by the OpenL MCP Server: Personal Access Token (PAT) and Basic Authentication.

## Table of Contents
- [Authentication Methods](#authentication-methods)
- [Setup](#setup)
- [Basic Authentication](#basic-authentication)
- [Personal Access Token Authentication](#personal-access-token-authentication)
- [Security Best Practices](#security-best-practices)
- [Troubleshooting](#troubleshooting)

## Authentication Methods

The MCP server supports two authentication methods:

1. **Basic Authentication** - Username and password
2. **Personal Access Token (PAT)** - User-generated tokens for programmatic access

Choose the method that best fits your security requirements and infrastructure.

## Setup

**IMPORTANT**: Authentication variables (tokens, passwords) **MUST NOT** be set in Docker configuration or server environment variables. They should be configured **only** in the MCP client configuration when connecting through Cursor or Claude Desktop.

### How It Works

The MCP server supports two modes of operation:

1. **stdio transport** (for Cursor/Claude Desktop) - authentication is set in the MCP client configuration via environment variables in the config file
2. **HTTP transport** (for Docker) - authentication is passed via query parameters or HTTP headers when connecting

### For Cursor IDE or Claude Desktop (stdio transport)

Configure authentication in the MCP client configuration file:

**Example for Cursor:**
```json
{
  "mcpServers": {
    "openl-mcp-server": {
      "command": "node",
      "args": ["<path-to-project>/dist/index.js"],
      "env": {
        "OPENL_BASE_URL": "http://localhost:8080",
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
      "args": ["<path-to-project>/dist/index.js"],
      "env": {
        "OPENL_BASE_URL": "http://localhost:8080",
        "OPENL_PERSONAL_ACCESS_TOKEN": "<your-pat-token>"
      }
    }
  }
}
```

### For HTTP Transport (Docker)

When connecting via HTTP, authentication is passed through:

1. **Query parameters** in URL:
   ```text
   http://localhost:3000/mcp/sse?OPENL_BASE_URL=http://studio:8080&OPENL_PERSONAL_ACCESS_TOKEN=<your-token>
   ```

2. **HTTP headers**:
   ```text
   X-OPENL-BASE-URL: http://studio:8080
   X-OPENL-PERSONAL-ACCESS-TOKEN: <your-token>
   ```

### Docker Configuration

In Docker configuration (`compose.yaml`), **only** the base URL is set:

```yaml
environment:
  PORT: 3000
  OPENL_BASE_URL: http://studio:8080
  NODE_ENV: production
  # Authentication is NOT set here!
```

⚠️ **Security**: Never set tokens, passwords, or other secrets in:
- Docker compose files
- Host environment variables (for Docker)
- Git repository
- Logs

✅ **Correct**: Set secrets only in:
- MCP client configuration files (Cursor/Claude Desktop)
- Query parameters or headers when connecting via HTTP (for one-time connections)

For complete configuration examples, see [MCP Connection Guide](../setup/mcp-connection-guide.md).

## Basic Authentication

Basic Authentication uses HTTP Basic Auth with username and password.

### Configuration

**Environment Variables:**
```bash
OPENL_BASE_URL=http://localhost:8080
OPENL_USERNAME=admin
OPENL_PASSWORD=admin
```

**Claude Desktop Config:**
```json
{
  "mcpServers": {
    "openl-studio": {
      "command": "node",
      "args": ["/path/to/dist/index.js"],
      "env": {
        "OPENL_BASE_URL": "http://localhost:8080",
        "OPENL_USERNAME": "admin",
        "OPENL_PASSWORD": "admin"
      }
    }
  }
}
```

### Use Cases
- Development and testing environments
- Internal networks with network-level security
- Quick setup and prototyping

### Security Considerations
- ❌ Credentials sent with every request
- ❌ Password stored in configuration
- ✅ Use HTTPS in production
- ✅ Rotate passwords regularly

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
      "args": ["<path-to-project>/dist/index.js"],
      "env": {
        "OPENL_BASE_URL": "https://openl.example.com",
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

- ✅ **More Secure Than Passwords** - Tokens can be revoked without password changes
- ✅ **Expiration Support** - Optional expiration dates
- ✅ **User-Scoped** - Tokens are tied to the user who created them
- ✅ **Revocable** - Can be deleted from UI at any time
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

1. **Always Use HTTPS** - Never send credentials over HTTP
2. **Rotate Credentials** - Regularly rotate passwords, API keys, and client secrets
3. **Least Privilege** - Use minimum required scopes/permissions
4. **Separate Environments** - Different credentials for dev/staging/production
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

### Basic Auth Issues

#### Authentication Failed

**Symptoms:**
```
OpenL Studio API error (401): Authentication required
```

**Solutions:**
1. Verify username and password are correct
2. Check user account is not locked
3. Ensure user has required permissions
4. Verify OpenL Studio is configured for basic auth

### General Issues

#### Connection Timeout

**Symptoms:**
```
Error: timeout of 30000ms exceeded
```

**Solutions:**
1. Increase timeout: `OPENL_TIMEOUT=60000`
2. Check network connectivity
3. Verify OpenL Studio is running
4. Check firewall rules

#### SSL/TLS Errors

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

### Basic Auth
```bash
OPENL_USERNAME          # Username for basic authentication
OPENL_PASSWORD          # Password for basic authentication
```

### Personal Access Token
```bash
OPENL_PERSONAL_ACCESS_TOKEN  # Personal Access Token (format: openl_pat_<publicId>.<secret>)
```

## Examples

### Local Development with Basic Auth
```bash
export OPENL_BASE_URL=http://localhost:8080
export OPENL_USERNAME=admin
export OPENL_PASSWORD=admin
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
