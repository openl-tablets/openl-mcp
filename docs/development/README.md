# Development Documentation

Documentation for developers contributing to the OpenL MCP Server.

**Community standards:** See [Code of Conduct](../../CODE_OF_CONDUCT.md) for expected behavior.

## Available Guides

- **[Contributing Guide](contributing.md)** - How to contribute to the project
- **[Architecture](architecture.md)** - System architecture and design
- **[Testing Guide](testing.md)** - Testing strategy and how to run tests
- **[Code Standards](code-standards.md)** - Best practices and coding standards
- **[Tool Review](tool-review.md)** - Technical review of MCP tools vs OpenL API

## Quick Start for Developers

1. **Read the Contributing Guide**: [contributing.md](contributing.md)
2. **Understand the Architecture**: [architecture.md](architecture.md)
3. **Set up Development Environment**: See [Contributing Guide - Development Setup](contributing.md#development-setup)
4. **Run Tests**: See [Testing Guide](testing.md)

## Development Workflow

```bash
# Install dependencies
npm install

# Build TypeScript
npm run build

# Run tests
npm test

# Run linter
npm run lint

# Development mode with auto-rebuild
npm run watch
```

## Code Structure

- `src/` - Source code (TypeScript)
- `tests/` - Jest test suites
- `prompts/` - AI assistant guidance templates
- `docs/` - Documentation

## Related Documentation

- [Main Documentation Index](../README.md)
- [Usage Guides](../guides/README.md)
- [Reference Materials](../reference/README.md)
