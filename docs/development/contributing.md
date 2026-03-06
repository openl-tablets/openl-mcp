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
├── index.ts             # MCP server entry point
├── server.ts            # HTTP server (SSE/StreamableHTTP)
├── client.ts            # OpenL Studio API client
├── auth.ts              # Authentication (Basic Auth, PAT)
├── tool-handlers.ts     # Tool registration and handlers
├── tools.ts             # Tool metadata definitions
├── schemas.ts           # Zod validation schemas
├── formatters.ts        # Response formatting
├── validators.ts        # Input validation
├── utils.ts             # Utility functions
├── types.ts             # TypeScript types
├── constants.ts         # Configuration constants
├── prompts.ts           # Prompt definitions
└── prompts-registry.ts  # Prompt management
```

## Adding a New Tool

### 1. Define Schema in `schemas.ts`

```typescript
export const myToolSchema = z.object({
  projectId: projectIdSchema,
  param: z.string().describe("Parameter description"),
  response_format: ResponseFormat.optional(),
  limit: z.number().int().positive().max(200).default(50).optional(),
  offset: z.number().int().nonnegative().default(0).optional(),
}).strict(); // Always use .strict()
```

### 2. Add Handler in `tool-handlers.ts`

```typescript
registerTool({
  name: "openl_my_tool",
  title: "My Tool",
  description: "Tool description",
  inputSchema: schemas.z.toJSONSchema(myToolSchema),
  annotations: {
    readOnlyHint: true,    // If read-only
    idempotentHint: true, // If safe to retry
    openWorldHint: true,
  },
  handler: async (args, client) => {
    const typedArgs = args as z.infer<typeof myToolSchema>;
    const result = await client.someMethod(typedArgs.projectId);
    
    return {
      content: [{
        type: "text",
        text: formatResponse(result, typedArgs.response_format || "markdown")
      }]
    };
  },
});
```

### 3. Add Metadata in `tools.ts`

```typescript
{
  name: "openl_my_tool",
  description: "Tool description",
  inputSchema: schemas.z.toJSONSchema(myToolSchema),
  _meta: {
    version: "1.0.0",
    category: TOOL_CATEGORIES.PROJECT,
    requiresAuth: true,
    modifiesState: false,
  },
}
```

### 4. Add API Method (if needed) in `client.ts`

```typescript
async myMethod(projectId: string): Promise<ReturnType> {
  const [repository, projectName] = this.parseProjectId(projectId);
  const response = await this.axiosInstance.get<ReturnType>(
    `/repos/${repository}/projects/${projectName}/endpoint`
  );
  return response.data;
}
```

### 5. Add Tests

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

### 6. Update Documentation

Add examples to `../guides/examples.md` and update `README.md` if needed.

## Key Guidelines

### Tool Naming
- **MUST** use `openl_` prefix
- Use snake_case: `openl_list_projects`

### Response Formatting
- Use `formatResponse()` from `formatters.ts`
- Support `response_format` parameter (json/markdown)
- Apply `paginateResults()` for array data

### Validation
- Always use `.strict()` on Zod schemas
- Validate all inputs before processing
- Use descriptive error messages

### Error Handling
- Use `McpError` with proper error codes
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

Use conventional commits:

```
feat(tools): add support for table validation
fix(auth): handle token refresh race condition
docs: update contributing guide
```

Types: `feat`, `fix`, `docs`, `refactor`, `test`, `chore`

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
