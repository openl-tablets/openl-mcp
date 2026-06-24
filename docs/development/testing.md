# Testing Guide

This document describes the testing strategy and how to run tests for the OpenL MCP Server.

## Test Structure

```text
tests/
├── mocks/
│   └── openl-api-mocks.ts          # Mock data for API responses
├── <module>.test.ts                # Unit tests, one file per src/<module>.ts
│                                   #   (auth, client, constants, formatters,
│                                   #    schemas, validators, prompts, …)
└── integration/                    # Integration tests (excluded from test:unit)
    ├── handlers.test.ts            # MCP tools via executeTool() + mocked HTTP
    ├── resources.test.ts           # MCP resource read/list/template handlers
    └── openl-live.test.ts          # Live tests against a real OpenL Studio
```

Each unit test file is named for the `src/` module it exercises; integration
tests (those wired through the OpenL client's mocked HTTP layer) live under
`tests/integration/`. The split is enforced by the npm scripts: `test:unit`
ignores the `integration` path, `test:integration` runs only that folder.

## Testing Stack

- **Jest**: Testing framework
- **ts-jest**: TypeScript support for Jest
- **axios-mock-adapter**: HTTP mocking layer for the OpenL client in tests
- **ESM Support**: Full ES module support for modern TypeScript

## Running Tests

### Run All Tests

```bash
npm test
```

### Run Tests in Watch Mode

```bash
npm run test:watch
```

### Generate Coverage Report

```bash
npm run test:coverage
```

This will generate:
- Console coverage summary
- HTML report in `coverage/` directory
- LCOV report for CI/CD integration

### View Coverage Report

```bash
open coverage/index.html  # macOS
xdg-open coverage/index.html  # Linux
start coverage/index.html  # Windows
```

## Test Categories

### Unit Tests (per `src/` module)

Each unit suite targets one module in isolation. For example, the API client
suite (`client.test.ts`) exercises individual client methods without running
the full MCP server:

- **Repository Management**
  - List repositories
  - Get repository features
  - List branches

- **Project Management**
  - List projects with/without filters
  - Get project details
  - Get project info (modules, dependencies)
  - Open/close projects
  - Get project history
  - Create branches

- **Table Management**
  - List tables in a project
  - Get table details (decision tables, datatypes)
  - Update tables
  - Error handling for missing tables

- **Deployment Management**
  - List deployments
  - Deploy projects
  - Redeploy projects
  - List production repositories

- **Authentication**
  - Personal Access Token (PAT)
  - Single-user mode (no Authorization header)
  - Unauthorized access handling

### Integration Tests (`tests/integration/`)

Exercise the MCP surface end-to-end with the OpenL client's HTTP layer mocked:

- **MCP Tools** (`handlers.test.ts`)
  - Every registered tool via `executeTool()` (list_repositories, list_projects, etc.)
  - Tool input validation
  - Tool output formatting
  - Error handling and edge cases

- **MCP Resources** (`resources.test.ts`)
  - Static resources (repositories, projects, deployments)
  - Parameterized resource templates and read/error paths

## Mock Data

Mock data is defined in `tests/mocks/openl-api-mocks.ts` and includes:

- **mockRepositories**: Sample design and production repositories
- **mockProjects**: Sample projects with different statuses
- **mockProjectInfo**: Project structure with modules and dependencies
- **mockTables**: Decision tables and datatypes
- **mockDecisionTable**: Complete decision table with rules
- **mockDatatype**: Datatype with fields
- **mockProjectHistory**: Version history
- **mockBranches**: Git branches
- **mockDeployments**: Deployment records

## Writing New Tests

### Example: Testing a New Tool

```typescript
describe('new_tool', () => {
  it('should perform expected operation', async () => {
    // Setup mock
    nock(BASE_URL)
      .get(`${API_PATH}/new-endpoint`)
      .reply(200, { result: 'success' });

    // Call the API
    const axios = (await import('axios')).default;
    const response = await axios.get(`${BASE_URL}${API_PATH}/new-endpoint`);

    // Assertions
    expect(response.status).toBe(200);
    expect(response.data.result).toBe('success');
  });

  it('should handle errors', async () => {
    // Setup error mock
    nock(BASE_URL)
      .get(`${API_PATH}/new-endpoint`)
      .reply(404, { message: 'Not found' });

    // Call and expect error
    const axios = (await import('axios')).default;
    await expect(
      axios.get(`${BASE_URL}${API_PATH}/new-endpoint`)
    ).rejects.toThrow();
  });
});
```

### Example: Adding Mock Data

```typescript
// In tests/mocks/openl-api-mocks.ts
export const mockNewData: NewType = {
  id: 'test-id',
  name: 'Test Name',
  // ... other fields
};
```

## Test Coverage Goals

- **Statements**: > 80%
- **Branches**: > 75%
- **Functions**: > 80%
- **Lines**: > 80%

Current coverage is displayed after running `npm run test:coverage`.

## Continuous Integration

Tests run automatically on:
- Push to main, develop, or claude/** branches
- Pull requests to main or develop
- Changes to mcp-server/** files

See `.github/workflows/ci.yml` for CI configuration.

## Common Testing Scenarios

### Testing Authentication

```typescript
it('should authenticate with a Personal Access Token', async () => {
  nock(BASE_URL, { reqheaders: { authorization: 'Token openl_pat_test' } })
    .get(`${API_PATH}/repos`)
    .reply(200, mockRepositories);

  const axios = (await import('axios')).default;
  const response = await axios.get(`${BASE_URL}${API_PATH}/repos`, {
    headers: { Authorization: 'Token openl_pat_test' }
  });

  expect(response.status).toBe(200);
});
```

### Testing Query Parameters

```typescript
it('should filter with query params', async () => {
  nock(BASE_URL)
    .get(`${API_PATH}/projects`)
    .query({ status: 'OPENED' })
    .reply(200, filteredProjects);

  const axios = (await import('axios')).default;
  const response = await axios.get(`${BASE_URL}${API_PATH}/projects`, {
    params: { status: 'OPENED' }
  });

  expect(response.data).toHaveLength(1);
});
```

### Testing Error Responses

```typescript
it('should handle 404 errors', async () => {
  nock(BASE_URL)
    .get(`${API_PATH}/projects/nonexistent`)
    .reply(404, { message: 'Not found' });

  const axios = (await import('axios')).default;

  await expect(
    axios.get(`${BASE_URL}${API_PATH}/projects/nonexistent`)
  ).rejects.toThrow();
});
```

### Testing POST/PUT Requests

```typescript
it('should create resource', async () => {
  const postData = { name: 'test', value: 123 };

  nock(BASE_URL)
    .post(`${API_PATH}/resource`, postData)
    .reply(201, { id: 'new-id', ...postData });

  const axios = (await import('axios')).default;
  const response = await axios.post(
    `${BASE_URL}${API_PATH}/resource`,
    postData
  );

  expect(response.status).toBe(201);
  expect(response.data.id).toBe('new-id');
});
```

## Debugging Tests

### Run Specific Test File

```bash
npm test client.test.ts
```

### Run Specific Test Suite

```bash
npm test -- -t "Repository Management"
```

### Run Specific Test

```bash
npm test -- -t "should list repositories"
```

### Enable Verbose Output

```bash
npm test -- --verbose
```

### Debug with Node Inspector

```bash
node --inspect-brk node_modules/.bin/jest --runInBand
```

Then open `chrome://inspect` in Chrome.

## Best Practices

1. **Arrange-Act-Assert**: Structure tests clearly
   ```typescript
   // Arrange: Setup mocks and data
   nock(BASE_URL).get('/api').reply(200, data);

   // Act: Perform the operation
   const result = await client.getData();

   // Assert: Verify results
   expect(result).toEqual(expected);
   ```

2. **Clean Up**: Use beforeEach/afterEach for cleanup
   ```typescript
   beforeEach(() => {
     nock.cleanAll();
   });
   ```

3. **Test Edge Cases**: Test error conditions, empty results, etc.

4. **Descriptive Names**: Use clear, descriptive test names

5. **Independent Tests**: Tests should not depend on each other

6. **Mock External Dependencies**: Use nock to mock HTTP calls

## Troubleshooting

### Tests Hang or Timeout

- Check for missing `scope.done()` calls
- Verify async operations are properly awaited
- Increase timeout: `jest.setTimeout(10000)`

### ESM Import Errors

- Ensure `type: "module"` in package.json
- Use `.js` extensions in imports
- Run with: `node --experimental-vm-modules`

### Nock Not Matching Requests

- Use `nock.recorder.rec()` to debug
- Check URL, headers, body exactly match
- Use `.log(console.log)` on nock scope

### Coverage Not Generated

- Ensure `collectCoverageFrom` in jest.config.js
- Check file paths are correct
- Run with `--coverage` flag

## Resources

- [Jest Documentation](https://jestjs.io/)
- [Nock Documentation](https://github.com/nock/nock)
- [ts-jest Documentation](https://kulshekhar.github.io/ts-jest/)
