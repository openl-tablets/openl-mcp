# 🔍 Troubleshooting Guide

This guide covers common issues and their solutions when working with the OpenL MCP Server.

## Table of Contents

- [Viewing Debug Logs](#viewing-debug-logs)
- [Common Issues](#common-issues)
- [Connection Issues](#connection-issues)
- [Remote SSE Connection Issues](#remote-sse-connection-issues)
- [Configuration Issues](#configuration-issues)

---

## Viewing Debug Logs

### Quick Method

#### 1. Claude Desktop Logs (macOS)

```bash
# View latest logs in real-time
tail -f ~/Library/Logs/Claude/*.log

# Or via Console.app (GUI)
open -a Console
# Then find Claude Desktop logs
```

#### 2. Cursor IDE Logs (macOS)

```bash
# View latest logs in real-time
tail -f ~/Library/Logs/Cursor/*.log
```

#### 3. Run Server Directly for Debugging

The easiest way to see all logs - run the server directly in terminal:

```bash
cd <path-to-project>

# Set environment variables
export OPENL_BASE_URL="http://localhost:8080"
export OPENL_USERNAME="admin"
export OPENL_PASSWORD="admin"
# Run the server
node dist/index.js
```

All logs will be visible directly in the terminal! Press `Ctrl+C` to stop.

### Detailed Debugging

#### Enable Verbose Logging

For more detailed logs, set the `DEBUG` environment variable:

```bash
export DEBUG=1
export NODE_ENV=development
node dist/index.js
```

#### Search for Specific Errors

**OpenL Connection Errors:**
```bash
tail -f ~/Library/Logs/Claude/*.log | grep -i "openl\|401\|unauthorized\|connection"
```


**Configuration Errors:**
```bash
tail -f ~/Library/Logs/Claude/*.log | grep -i "config\|environment\|missing"
```

### Log Structure

All MCP server logs have prefixes for easy filtering:

- `[Config]` - configuration logs
- `[Auth]` - authentication logs
- `[Browser]` - browser interaction logs
- `[Error]` - errors

**Example Log Filtering:**
```bash
# Errors only
tail -f ~/Library/Logs/Claude/*.log | grep "\[Error\]"


# Configuration logs only
tail -f ~/Library/Logs/Claude/*.log | grep "\[Config\]"
```

### Server Health Checks

#### Test 1: Build Check

```bash
cd <path-to-project>
npm run build
```

If build is successful, there will be no errors.

#### Test 2: Configuration Check

```bash
# Check Claude Desktop configuration
cat ~/Library/Application\ Support/Claude/config.json | jq '.mcpServers["openl-mcp-server"]'
```

#### Test 3: OpenL Connection Check

```bash
curl -u admin:admin http://localhost:8080/rest/repos
```

If OpenL is running, you'll get JSON with repositories.

#### Test 4: Run Server with Verification

```bash
cd <path-to-project>

# Set environment variables from your configuration
export OPENL_BASE_URL="http://localhost:8080"
export OPENL_USERNAME="admin"
export OPENL_PASSWORD="admin"
# Run the server
node dist/index.js
```

You should see initialization logs:
```
[Config] Loading configuration from environment variables...
[Config] Authentication methods:
[Config]   - API Key: not configured
[Config]   - Basic Auth: configured (username: admin)
```

If the server starts without errors, everything is working correctly.

### Useful Commands

**View last 100 lines of logs:**
```bash
tail -n 100 ~/Library/Logs/Claude/*.log
```

**Search for all errors in the last hour:**
```bash
grep -i error ~/Library/Logs/Claude/*.log | tail -20
```

**Monitor logs in real-time:**
```bash
tail -f ~/Library/Logs/Claude/*.log | grep --color=always -E "error|Error|ERROR|\[Error\]|\[Auth\]|\[Config\]"
```

**Save logs to file:**
```bash
tail -f ~/Library/Logs/Claude/*.log > mcp-debug.log 2>&1
```

---

## Common Issues

### Issue: "require is not defined"

**Solution:** Make sure the project is rebuilt:
```bash
cd <path-to-project>
npm run build
```

### Issue: "Unexpected token 'C', '[Config] Lo'... is not valid JSON"

**Solution:** This means logs are going to stdout. Make sure you're using the latest code where all logs go to stderr via `console.error()`.

### Issue: Server doesn't start

**Solution:** Check logs directly:
```bash
cd <path-to-project>
node dist/index.js 2>&1 | tee debug.log
```

Then open `debug.log` to view all errors.

### Issue: No logs in Claude Desktop

**Solution:** 
1. Make sure Claude Desktop is completely restarted (not just minimized)
2. Check that logging is enabled in Claude Desktop settings
3. Try running the server directly to verify

### Issue: MCP Server doesn't appear in AI client

**Solution:**
1. Check path to `dist/index.js` (must be absolute)
2. Ensure project is built: `npm run build`
3. Restart your AI client

### Issue: "Cannot connect to OpenL API"

**Solution:**
1. Ensure OpenL Studio is running:
   ```bash
   curl http://localhost:8080/rest/projects
   ```
2. Check `OPENL_BASE_URL` in configuration
3. Ensure `OPENL_BASE_URL` points to the OpenL server base URL (trailing slash is optional).

### Issue: "Authentication failed"

**Solution:**
1. Check credentials (`OPENL_USERNAME`, `OPENL_PASSWORD`)
2. Try logging into OpenL via browser with the same credentials
3. Ensure user has necessary permissions

### Issue: Tools don't work in chat

**Solution:**
1. Check MCP server status in settings (should be "Connected")
2. Try explicitly asking the AI to use the tool
3. Check logs for errors

---

## Connection Issues

### Issue: Docker containers don't start

**Solution:**
1. Check that Docker is running:
   ```bash
   docker ps
   ```
2. Check ports (8080, 5432 should not be occupied):
   ```bash
   lsof -i :8080
   lsof -i :5432
   ```
3. View logs:
   ```bash
   docker compose logs
   ```

### Issue: Port 3000 occupied (Docker)

**Solution:**
Change port in `compose.yaml`:
```yaml
ports:
  - "3001:3000"  # External:Internal
```

Or set environment variable:
```yaml
environment:
  PORT: 3001
```

---

## Remote SSE Connection Issues

### Problem: Connection Issues with Remote SSE

If you're experiencing:
- `Request timed out` errors
- Connection issues with remote SSE transport
- Authentication failures

### Root Cause

Possible causes:
1. Incorrect Node.js or `mcp-remote` paths
2. Network connectivity issues
3. Invalid or expired PAT token
4. Remote SSE endpoint may not be responding correctly

### Solution: Use Local MCP Server with Remote OpenL Backend

Instead of connecting to remote MCP server via SSE, run the MCP server locally and connect it to the remote OpenL backend via API.

**Configuration:**

**macOS/Linux:**
```json
{
  "mcpServers": {
    "openl": {
      "command": "node",
      "args": [
        "<path-to-project>/dist/index.js"
      ],
      "env": {
        "OPENL_BASE_URL": "https://<your-openl-server>",
        "OPENL_PERSONAL_ACCESS_TOKEN": "<your-pat-token>"
      }
    }
  }
}
```

**Prerequisites:**

1. **Build the MCP server:**
   ```bash
   cd <path-to-project>
   npm install
   npm run build
   ```

2. **Verify the build:**
   ```bash
   ls -la dist/index.js
   # Should exist and be executable
   ```

**Advantages:**
- ✅ Reliable stdio transport (no network issues)
- ✅ Full control over authentication
- ✅ Better error messages and debugging
- ✅ Works even if remote SSE endpoint has issues
- ✅ No dependency on `mcp-remote` package

### Alternative: Verify Remote SSE Configuration

Make sure you're using the correct format with `--header` flag:

```json
{
  "mcpServers": {
    "openl-remote": {
      "command": "/path/to/node",
      "args": [
        "/path/to/mcp-remote",
        "https://<your-openl-server>/mcp/sse",
        "--header",
        "Authorization: Token <your-pat-token>"
      ]
    }
  }
}
```

**Important:** Use absolute paths for both `command` and the first `args` element (mcp-remote path).

### Why This Works Better

1. **stdio transport** is more reliable than SSE for MCP
2. **Local process** gives better error visibility
3. **API** connection to OpenL is well-tested and stable
4. **No npm package dependencies** - just Node.js and your built MCP server

### Verification

After updating the configuration:

1. **Restart Claude Desktop completely**
2. **Check MCP server status** in settings (should show "Connected")
3. **Test with a simple query:**
   ```
   List repositories in OpenL Studio
   ```

If you still see timeouts, check:
- Network connectivity to `https://<your-openl-server>`
- PAT token validity
- MCP server build status

---

## Configuration Issues

### Issue: File doesn't exist

**Solution:**
1. Ensure project is built:
   ```bash
   cd <path-to-project>
   npm run build
   ls -la dist/index.js  # Should exist
   ```
2. Verify the path in configuration matches the actual location

### Issue: Environment variables not set

**Solution:**
1. Check configuration file for your AI client
2. Ensure all required variables are set:
   - `OPENL_BASE_URL` (required)
   - At least one authentication method (username/password, API key, or OAuth2)
3. Restart your AI client after changing configuration

---

## Additional Information

- All MCP server logs go to **stderr** (via `console.error()`) to avoid interfering with JSON-RPC protocol on stdout
- AI client logs are automatically saved to their respective log directories
- For debugging, it's recommended to run the server directly in terminal
- Use `DEBUG=1` environment variable for more verbose logs

## Related Documentation

- [Authentication Guide](authentication.md) - Authentication setup and troubleshooting
- [MCP Connection Guide](../setup/mcp-connection-guide.md#troubleshooting) - Connection troubleshooting
- [Quick Start Guide](../getting-started/quick-start.md) - Quick setup instructions
- [Usage Examples](examples.md) - Usage examples and workflows

For more help:
- [Quick Start Guide](../getting-started/quick-start.md)
- [MCP Connection Guide](../setup/mcp-connection-guide.md)
- [Authentication Guide](authentication.md)

