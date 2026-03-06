# Security Policy


## Reporting a Vulnerability

**Please do not report security vulnerabilities through public GitHub issues, pull requests, or discussions.**

### How to Report

**Primary method (recommended):**
1. Go to the [Security tab](https://github.com/openl-tablets/openl-mcp/security) of this repository
2. Click "Report a vulnerability"
3. Follow the private vulnerability reporting workflow

### Safe Harbor

We support responsible disclosure and will not pursue legal action against security researchers who:
- Make a good faith effort to avoid privacy violations and service disruption
- Report vulnerabilities promptly and privately
- Give us reasonable time to fix issues before public disclosure

### What to Include

Please include the following information in your report:

- **Description**: Clear description of the vulnerability
- **Impact**: What an attacker could do with this vulnerability
- **Steps to Reproduce**: Detailed steps to reproduce the issue
- **Affected Versions**: Which versions are affected
- **Environment**: OS, Node.js version, OpenL Studio version
- **Proof of Concept**: Code or commands demonstrating the issue (if applicable)
- **Suggested Fix**: If you have ideas on how to fix it (optional)

### Response Timeline

After you submit a vulnerability report:

- **Acknowledgment**: We will acknowledge receipt of your vulnerability report within 3 business days
- **Assessment**: We will investigate the vulnerability and assess its impact
- **Communication**: We will keep you informed about our progress
- **Resolution**: We will work on a fix and coordinate disclosure timing with you
- **Credit**: We will credit you in the security advisory (unless you prefer to remain anonymous)

### Disclosure Policy

- We will confirm receipt of your vulnerability report
- We will investigate and provide regular updates on our progress
- We will notify you when the vulnerability is fixed
- We will publicly disclose the vulnerability after a fix is released
- We will credit you in the security advisory (unless you prefer to remain anonymous)

## Security Best Practices

### For Users

1. **Use Personal Access Tokens (PAT)** instead of Basic Auth in production
2. **Always use HTTPS/TLS** when connecting to OpenL Studio in production
3. **Never commit credentials** to version control
4. **Rotate tokens regularly** and revoke unused tokens immediately
5. **Keep dependencies updated**: Run `npm audit` regularly; apply updates intentionally with lockfile and CI testing
6. **Use environment variables** for all sensitive configuration

### For Developers

1. **Never log sensitive data**: Passwords, tokens, or API keys
2. **Validate all inputs**: Use Zod schemas for runtime validation
3. **Sanitize error messages**: Redact credentials from error outputs
4. **Use strict TypeScript**: Enable strict mode and fix all type errors
5. **Review dependencies**: Check for known vulnerabilities before adding new packages
6. **Test security features**: Write tests for authentication and authorization logic

## Known Security Considerations

### Authentication

- **Basic Auth**: Credentials are Base64-encoded (not encrypted). Always use HTTPS in production.
- **Personal Access Token (PAT)**: Recommended for production. Tokens should be treated as passwords.
- **Token Storage**: Never hardcode tokens in source code. Use environment variables or secure vaults.

### MCP Transport Security

This server implements multiple MCP transport modes. Each has specific security requirements:

- **stdio transport**: Runs as a subprocess; inherits security context of parent process. Safe for local Claude Desktop use.
- **Streamable HTTP / SSE transport**: 
  - **Origin Validation**: The server validates `Origin` headers to prevent DNS rebinding attacks
  - **Localhost Binding**: When running locally, bind to `localhost` (not `0.0.0.0`) to prevent external access
  - **Authentication Required**: Always require authentication for HTTP transports; never expose unauthenticated endpoints
  - **Session Handling**: Verify all inbound requests; do not rely solely on session-based authentication without additional validation

**Important**: When exposing MCP over HTTP, treat it as a privileged API that can execute commands and modify data. Use defense-in-depth (authentication + authorization + input validation).

### Input Validation

- All tool parameters are validated using Zod schemas
- Invalid inputs are rejected before processing
- Error messages are sanitized to prevent information leakage

### Credential Redaction

The server redacts sensitive data from error messages, logs, and API responses to prevent credential leakage. This includes tokens, passwords, API keys, and authorization headers.

### MCP-Specific Risks: Prompt Injection & Tool Chaining

MCP servers are often used in chains with other tools and AI models. This creates unique security risks:

**Prompt Injection Risks:**
- AI models may pass maliciously crafted arguments to tools (e.g., paths like `../../etc/passwd`, arguments like `--force`)
- **Never trust tool inputs**, even if they appear to come from an AI assistant
- Validate all paths, filenames, and arguments strictly using allowlists where possible

**Tool Chaining Hardening:**
1. **Path Validation**: Deny absolute paths, parent directory traversal (`..`), and symbolic links unless explicitly required
2. **Argument Validation**: Reject option-like arguments (starting with `-` or `--`) in user-controlled fields
3. **Strict Type Validation**: Use Zod schemas to enforce types, formats, and bounds on all inputs
4. **Allowlists Over Denylists**: For filenames, project IDs, and commands, use allowlists when feasible
5. **Audit All State-Changing Operations**: Log all creates, updates, deletes, and deployments with full context

**Real-world example**: Public MCP security advisories have documented argument injection and path traversal attacks in Git-based MCP tools that enabled file overwrites and command execution when chained with other servers.

**Defense strategy**: Treat every tool invocation as potentially malicious. Validate early, fail safely, and never assume the model will provide safe inputs.

## Security Updates

Security updates will be released as patch versions (e.g., 1.0.1, 1.0.2) and announced via:

- [GitHub Security Advisories](https://github.com/openl-tablets/openl-mcp/security/advisories)
- [GitHub Releases](https://github.com/openl-tablets/openl-mcp/releases)
- CHANGELOG.md with a `### Security` section

Subscribe to repository notifications to receive security updates.

## Scope

This security policy applies to:

- Source code in this repository
- Published releases (npm packages and Docker images, if/when published)

This policy does **not** cover:

- OpenL Studio/OpenL Tablets server itself (report to OpenL Tablets project)
- Third-party dependencies (report to respective maintainers)
- Deployment infrastructure (cloud providers, Kubernetes, etc.)

## Resources

- [OWASP Top 10](https://owasp.org/www-project-top-ten/)
- [Node.js Security Best Practices](https://nodejs.org/en/docs/guides/security/)
- [npm Security Best Practices](https://docs.npmjs.com/security-best-practices)
