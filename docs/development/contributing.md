# Contributing to OpenL MCP Server

Thank you for your interest in contributing! This guide covers the essentials for extending the codebase.

**By participating in this project, you agree to abide by our [Code of Conduct](../../CODE_OF_CONDUCT.md).**

## Development Setup

### Prerequisites
- Node.js 24.0.0+
- npm or yarn
- Access to OpenL Studio for testing

### Quick Start

```bash
npm install
npm run build
npm test
npm run lint
```

### Development Commands

```bash
npm run watch          # Auto-rebuild on changes
npm run test:watch     # Test in watch mode
npm run lint:fix       # Fix linting issues
```

## Code Structure

```
src/
├── index.ts                # Binary entry point / transport dispatcher
├── stdio-server.ts         # stdio transport (Claude Desktop / Cursor)
├── http-server.ts          # Streamable HTTP transport (/mcp) and the /health probe
├── cli.ts                  # CLI mode — run any registered tool straight from the shell
├── mcp-core.ts             # Shared MCP core (tool/prompt request handlers) for both transports
├── client.ts               # OpenL Studio REST API client
├── auth.ts                 # Authentication (Personal Access Token)
├── stomp-client.ts         # Minimal STOMP client for Studio's websocket topics
├── stomp-waits.ts          # Awaits async Studio compilation over STOMP inside one tool call
├── handlers/               # Tool registry and per-category tool handlers (see below)
├── schemas.ts              # Zod input schemas, one per tool
├── formatters.ts           # JSON/Markdown formatting, pagination, response size limits
├── content-utils.ts        # Text/binary detection and encoding for file content over MCP
├── prompts-registry.ts     # Loads and renders the prompt templates in prompts/
├── guides-registry.ts      # Runtime reader of the bundled OpenL documentation (guides/)
├── fetch-guides.ts         # Build step that downloads and bundles that documentation
├── build-info.ts           # Runtime version/build identity (reads build-info.json)
├── generate-build-info.ts  # Build step that records the build identity
├── verify-package.ts       # Release gate: the tarball must carry that identity
├── project-templates.ts    # Bundled project skeletons used by openl_create_project
├── logger.ts               # Structured stderr logging with credential sanitization
├── utils.ts                # Shared helpers (error extraction, sanitization, hashing)
├── types.ts                # TypeScript types for the OpenL Studio API
└── constants.ts            # Defaults, tool namespace prefix, categories, server identity
```

Tools live in one module per category, all registering into the same registry:

```
src/handlers/
├── index.ts                    # Registry entry point (registerAllTools / getAllTools / executeTool)
├── common.ts                   # Registry core (registerTool, ToolDefinition) and shared error handling
├── guide-handlers.ts           # Onboarding, bundled documentation, per-project AGENTS.md context
├── repository-handlers.ts      # Design and deploy repositories, branches, project revisions
├── project-handlers.ts         # Project list/get/status, open/save/close, creation
├── project-merge-handlers.ts   # Project branches, merging, read-only conflict inspection
├── local-change-handlers.ts    # Uncommitted local changes and restore
├── file-handlers.ts            # Project files: read, write, delete, search, copy, move
├── table-handlers.ts           # List/get tables and update/append/create them
├── table-action-handlers.ts    # Raw-source edits: rows, columns, cells, merge/unmerge
├── table-workflow-handlers.ts  # Table execution, dependency and module/sheet/property discovery
├── table-id-tracking.ts        # Old→new table-id aliasing after an edit relocates a table
├── testing-handlers.ts         # Start project tests and read their results
├── trace-handlers.ts           # Interactive rule debugger (breakpoints, stepping, inspection)
├── deployment-handlers.ts      # Deploy/redeploy projects and list deployments
└── diagnostics-handlers.ts     # Server version and build identity
```

## Adding a New Tool

### 1. Define Schema in `schemas.ts`

```typescript
export const myToolSchema = z.object({
  projectId: projectIdSchema,
  param: z.string().describe("Parameter description"),
  response_format: ResponseFormat.optional(),
}).merge(PaginationParams).strict(); // Always use .strict()
```

### 2. Register the Tool in its category module under `src/handlers/`

```typescript
registerTool({
  name: "my_tool",                 // bare name — the openl_ prefix is added on the MCP wire
  title: "My Tool",
  description: "Tool description",
  category: "Project",             // one of TOOL_CATEGORIES (src/constants.ts)
  schema: myToolSchema,
  annotations: {
    readOnlyHint: true,    // If read-only
    idempotentHint: true, // If safe to retry
    openWorldHint: true,
  },
  handler: async (args, client) => {
    // args is already the validated z.output<typeof myToolSchema>.
    const result = await client.someMethod(args.projectId);
    
    return {
      content: [{
        type: "text",
        text: formatResponse(result, args.response_format)
      }]
    };
  },
});
```

### 3. Add API Method (if needed) in `client.ts`

```typescript
async myMethod(projectId: string): Promise<ReturnType> {
  const projectPath = this.buildProjectPath(projectId);
  const response = await this.axiosInstance.get<ReturnType>(
    `${projectPath}/endpoint`
  );
  return response.data;
}
```

### 4. Add Tests

```typescript
describe("openl_my_tool", () => {
  it("should handle valid input", async () => {
    // Test implementation
  });
  
  it("should validate input with strict schema", async () => {
    // Test .strict() validation
  });
});
```

### 5. Update Documentation

Add examples to `../guides/examples.md` and update `README.md` if needed.

## Key Guidelines

### Tool Naming
- Register bare snake_case names such as `list_projects`; the server adds the
  `openl_` prefix at the MCP boundary.
- Do not store or compare prefixed names inside the registry.

### Response Formatting
- Use `formatResponse()` from `formatters.ts`
- Support all shared `response_format` values: `json` (default), `markdown`,
  `markdown_concise`, and `markdown_detailed`
- Use `paginateCollection()` for backend page envelopes; use
  `paginateResults()` only for genuinely local arrays.

### Validation
- Always use `.strict()` on Zod schemas
- Let the central tool dispatcher parse inputs with the registered schema;
  handlers consume the validated output directly.
- Use descriptive error messages

### Error Handling
- Use `ProtocolError` with the appropriate `ProtocolErrorCode`
- Include context (endpoint, method, status)
- Sanitize sensitive data in errors

## Code Style

- **TypeScript strict mode** (enabled)
- **Interfaces** over types for object shapes
- **async/await** over promises
- **Explicit return types** on functions
- **JSDoc comments** on public functions

### Naming Conventions
- Classes: `PascalCase`
- Functions: `camelCase`
- Constants: `UPPER_SNAKE_CASE`
- Files: `kebab-case` (lowercase with hyphens)
  - Exception: Files in `prompts/` use `snake_case` as they serve as MCP prompt identifiers

## Testing

```bash
npm test                    # Run all tests
npm test -- file.test.ts    # Run specific file
npm run test:coverage        # With coverage
npm run test:watch          # Watch mode
```

## Submitting Changes

### Before Submitting
1. Run tests: `npm test`
2. Run linter: `npm run lint`
3. Build: `npm run build`
4. Update documentation
5. Add tests for new features

### Commit Messages

Follow the repository convention in `AGENTS.md`: prefix ticket-related work with
the Jira key and write an imperative subject that explains the benefit.

```
EPBDS-16385 Align MCP contracts with current Studio API
```

Fold unpushed review fixes into the commit that introduced them; do not add
co-author trailers.

## Security

- Never log sensitive data (passwords, tokens)
- Use environment variables for credentials
- Validate all inputs with Zod schemas
- Sanitize error messages

## Getting Help

- Check existing documentation
- Review existing code for patterns
- Search for similar issues

---

Thank you for contributing!
