# Debugging Personal Access Token (PAT)

Guide for enabling detailed logging to debug PAT authentication.

## Enabling DEBUG mode

Run the server with `DEBUG_AUTH=true` (or `DEBUG=true`) to log detailed PAT
authentication.

**Directly (npx or Docker):**

```bash
DEBUG_AUTH=true npx -y openl-mcp-server http://localhost:8080
```

**In a client config** — add it to the `env` block that launches the server:

```json
"env": {
  "OPENL_PERSONAL_ACCESS_TOKEN": "<your-pat-token>",
  "DEBUG_AUTH": "true"
}
```

**Full-stack compose** — add `DEBUG_AUTH: "true"` to the `openl-mcp` service's
`environment`, or run a one-off:

```bash
docker compose run -e DEBUG_AUTH=true openl-mcp
```

## What Gets Logged

### When Setting Authorization Header:

```
[Auth] ========================================
[Auth] 🔐 Personal Access Token Authentication
[Auth] ========================================
[Auth] PAT Configuration:
[Auth]   - PAT present: true
[Auth]   - PAT length: 64 characters
[Auth]   - PAT format valid: ✓
[Auth]   - PAT prefix: openl_pat_<your-prefix>...
[Auth] Authorization Header:
[Auth]   - Header name: Authorization
[Auth]   - Header value format: Token <PAT>
[Auth]   - Header value (safe): Token [redacted]
[Auth]   - Header set in config: true
[Auth]   - Header verification: ✓ Correct format
[Auth] ========================================
```

### On Each HTTP Request:

```
[Auth] ========================================
[Auth] Request Interceptor:
[Auth]   Method: GET
[Auth]   URL: http://studio:8080/rest/repos
[Auth]   Headers present: true
[Auth]   Authorization header: Token [redacted]
[Auth]   Authorization header starts with: Token ✓
[Auth] ========================================
```

### On 401 Error:

```
[Auth] ========================================
[Auth] ❌ 401 Unauthorized Error:
[Auth]   Method: GET
[Auth]   URL: http://studio:8080/rest/repos
[Auth]   Auth method: Personal Access Token
[Auth]   Authorization header sent: Token [redacted]
[Auth]   Header format check: Token ✓
[Auth]   Response status: 401
[Auth]   Response data: {...}
[Auth] ========================================
```

## Header Verification

Header should be set in format:
```
Authorization: Token <your-pat-token>
```

**Important:** Uses `Token` prefix, not `Bearer`.

## Viewing logs

Run directly and the logs print to the terminal (stderr). With compose:

```bash
# Only authentication logs
docker compose logs -f openl-mcp | grep "\[Auth\]"

# Logs with error context
docker compose logs -f openl-mcp | grep -A 10 -B 5 "401\|ERROR\|Failed"
```

## Common Issues

### 1. PAT Not Set

```
[Auth] ⚠️  No authentication method configured!
[Auth]   personalAccessToken: not configured
```

**Solution:** Provide the PAT in your client config — `env` → `OPENL_PERSONAL_ACCESS_TOKEN` for stdio, or the `Authorization` header for HTTP. Never bake it into the server.

### 2. Incorrect Header Format

If header doesn't start with `Token `, check:
- Correctness of PAT in configuration
- That correct authentication method is used

### 3. 401 Unauthorized

If you get 401, check:
- PAT hasn't expired (if expiration was set)
- PAT wasn't deleted in UI
- OpenL Studio is configured for OAuth2/SAML mode
- Token format is correct

## Manual Header Testing

For MCP configuration use `OPENL_BASE_URL=http://localhost:8080` (without `/rest`).
When testing OpenL API directly via `curl`, use API endpoints under `/rest`.

```bash
# Test via curl
curl -H "Authorization: Token <your-pat-token>" \
  http://localhost:8080/rest/repos
```

