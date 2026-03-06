# OpenL MCP Server - Spec Kit

This directory contains [GitHub Spec Kit](https://github.com/github/spec-kit) artifacts for the OpenL MCP Server. Spec Kit implements "Spec-Driven Development" - a methodology where specifications become executable and directly generate working implementations.

## What is Spec Kit?

Spec Kit is a toolkit that helps AI coding agents understand projects through structured documentation. It consists of four core artifacts that guide development:

1. **Constitution** - Governing principles and development guidelines
2. **Specification** - Functional requirements describing what to build
3. **Implementation Plan** - Technical architecture and tech stack choices
4. **Task List** - Actionable breakdown of work items

## Project Status

**Current Version**: 2.0.0
**Status**: Production Ready (v2.0.0 refactoring complete, test coverage expansion in progress)
**Last Updated**: 2025-11-16

## Artifacts

### 📜 [constitution.md](./memory/constitution.md)

#### Governing principles and development guidelines for the MCP server

**Key topics**:
- Core principles (Type Safety, Security First, Modular Architecture)
- Development guidelines (Code style, commit format, testing requirements)
- Quality gates (pre-commit, pre-PR, pre-release)
- Non-negotiables (no credentials in code, no any types, etc.)
- Decision-making framework

**Use when**:
- Starting development on a new feature
- Making architectural decisions
- Reviewing code for compliance
- Onboarding new contributors
- Resolving design debates

### 📋 [specification.md](./memory/specification.md)

#### Functional requirements describing what the MCP server does

**Key topics**:
- Core capabilities (10 major capabilities)
- All 18 MCP tools with detailed descriptions (openl_ prefix naming)
- 15 prompts with usage guidance
- Functional requirements (FR-1 through FR-15, including pagination & formatting)
- Non-functional requirements (security, performance, reliability)
- Success criteria

**Use when**:
- Understanding what the server should do
- Adding new features (check if it fits)
- Writing tests (what to test)
- Documenting behavior
- Clarifying requirements

### 🏗️ [implementation-plan.md](./memory/implementation-plan.md)

#### Technical architecture and implementation details

**Key topics**:
- Technology stack (Node.js, TypeScript, MCP SDK, Axios, Zod)
- Architecture (high-level, module structure, data flow)
- Implementation details (auth system, validation, error handling, prompts)
- Build and deployment (TypeScript compilation, packaging, configuration)
- Performance optimizations
- Security measures

**Use when**:
- Understanding how the server works
- Implementing new features
- Debugging issues
- Optimizing performance
- Planning deployments

### ✅ [task-list.md](./memory/task-list.md)

#### Actionable work items with priorities and estimates

**Key topics**:
- 40 total tasks (10 completed, 30 remaining)
- Prioritized (P0-P3)
- Estimated effort (includes refactoring completion and new test tasks)
- Sprint planning (updated with refactored architecture testing)
- Dependencies and risks
- Success criteria

**Use when**:
- Planning work
- Estimating effort
- Prioritizing features
- Tracking progress
- Sprint planning

## Using Spec Kit with AI Agents

### Claude Code

**Referencing artifacts**:
```text
"Review the constitution for code style guidelines"
"Check the specification for tool requirements"
"What does the implementation plan say about authentication?"
"Show me the next P0 task from the task list"
```

**When making changes**:
```text
"Add a new tool following the constitution and implementation plan"
"Implement T-001 from the task list"
"Update the specification to include the new requirement"
"Check if this change complies with the constitution"
```

### GitHub Copilot / Cursor / Windsurf

1. Open the relevant Spec Kit artifact
2. Use it as context when writing code
3. Reference specific sections in comments:
   ```typescript
   // Implements FR-7: Authentication Management (see specification.md)
   // Follows Security First principle (see constitution.md)
   ```

### Slash Commands (if Spec Kit CLI installed)

```bash
/speckit.constitution  # View governing principles
/speckit.specification # View functional requirements
/speckit.plan          # View implementation plan
/speckit.tasks         # View actionable work items
```

## Workflow Examples

### Adding a New Tool

1. **Constitution**: Check development guidelines and extension pattern
2. **Specification**: Verify the tool fits the project scope
3. **Implementation Plan**: Follow the 5-step tool addition process
4. **Task List**: Check if there's already a related task

**Steps**:
```text
1. Review constitution.md → Development Guidelines → Extension Pattern
2. Check specification.md → Ensure new tool aligns with core capabilities
3. Follow implementation-plan.md → Implementation Details → Adding Tools
4. Update task-list.md → Add new task if not exists
5. Implement following all guidelines
```

### Improving Test Coverage

1. **Task List**: Find test coverage tasks (T-001 through T-007)
2. **Constitution**: Review testing requirements
3. **Specification**: Understand what needs to be tested
4. **Implementation Plan**: See where tests should be added

**Steps**:
```text
1. Check task-list.md → Find T-001 (auth.ts tests)
2. Review constitution.md → Testing Requirements → Coverage targets
3. Read specification.md → FR-2: Input Validation → What to validate
4. Follow implementation-plan.md → Testing → Test structure
5. Write tests
```

### Debugging an Issue

1. **Implementation Plan**: Understand architecture and data flow
2. **Specification**: Verify expected behavior
3. **Constitution**: Check if error handling follows guidelines

**Steps**:
```text
1. Read implementation-plan.md → Data Flow → Tool Execution Flow
2. Check specification.md → FR-3: Error Handling → Expected errors
3. Verify constitution.md → Error Handling Consistency → Pattern
4. Fix issue following guidelines
```

### Planning a Sprint

1. **Task List**: Review active tasks and priorities
2. **Constitution**: Understand quality gates
3. **Specification**: Know success criteria

**Steps**:
```text
1. Review task-list.md → Sprint Planning → Sprint 1-5
2. Select tasks based on priority (P0 → P1 → P2)
3. Check constitution.md → Quality Gates → Pre-PR requirements
4. Verify specification.md → Success Criteria
5. Execute sprint
```

## Project Structure with Spec Kit

```text
mcp-server/
├── .specify/                       # Spec Kit artifacts
│   ├── README.md                   # This file
│   └── memory/
│       ├── constitution.md         # Governing principles
│       ├── specification.md        # Functional requirements
│       ├── implementation-plan.md  # Technical architecture
│       └── task-list.md            # Actionable work items
├── src/                            # Source code
│   ├── index.ts                    # MCP server (implementation)
│   ├── client.ts                   # OpenL API client (implementation)
│   ├── auth.ts                     # Authentication (implementation)
│   └── ...                         # Other modules (implementation)
├── tests/                          # Test suite (implementation)
├── prompts/                        # Prompt templates (implementation)
├── README.md                       # User documentation
├── docs/                           # Documentation
│   ├── guides/
│   │   ├── authentication.md       # Auth setup guide
│   │   └── examples.md             # Usage examples
│   └── development/
│       ├── contributing.md          # Developer guide
│       └── testing.md               # Testing guide
```

**Relationship**:
- `.specify/` = WHAT and HOW (spec)
- `src/` = IMPLEMENTATION (code)
- `tests/` = VERIFICATION (tests)
- `*.md` (root) = USER DOCUMENTATION (docs)

## Maintaining Spec Kit Artifacts

### When to Update

**Constitution** - Rarely (core principles are stable)
- When adding new development guidelines
- When establishing new quality gates
- When modifying non-negotiables

**Specification** - Occasionally (when requirements change)
- When adding new tools or features
- When changing functional requirements
- When updating success criteria

**Implementation Plan** - Occasionally (when architecture changes)
- When changing technology stack
- When refactoring major systems
- When adding new subsystems

**Task List** - Frequently (ongoing work tracking)
- When completing tasks (mark done)
- When adding new work items
- When re-prioritizing
- During sprint planning

### Update Process

1. **Make code changes**
2. **Update relevant Spec Kit artifacts**
3. **Commit both together**
4. **Keep artifacts in sync with code**

**Example commit**:
```text
feat(auth): add SAML authentication support

- Implement SAML auth in auth.ts
- Update specification.md to document new auth method
- Update implementation-plan.md with SAML flow
- Add T-026 to task-list.md for testing
```

## Benefits of Spec Kit

### For AI Agents
- **Clear context**: Understand project without reading all code
- **Guided development**: Follow established patterns
- **Consistent quality**: Adhere to principles automatically
- **Efficient work**: Know what to do next

### For Developers
- **Onboarding**: New developers understand project quickly
- **Decision-making**: Clear framework for choices
- **Quality**: Enforced standards
- **Progress tracking**: Visible task completion

### For Teams
- **Alignment**: Everyone follows same principles
- **Documentation**: Always up-to-date with code
- **Planning**: Clear roadmap and priorities
- **Knowledge transfer**: Spec Kit is single source of truth

## Spec Kit Best Practices

### DO:
- ✅ Reference Spec Kit artifacts in code comments
- ✅ Update artifacts when changing code
- ✅ Use task list for sprint planning
- ✅ Follow constitution for all decisions
- ✅ Check specification before adding features

### DON'T:
- ❌ Let artifacts drift from code
- ❌ Bypass principles in constitution
- ❌ Add features not in specification
- ❌ Ignore task priorities
- ❌ Make architectural changes without updating plan

## Resources

- **Spec Kit Project**: [https://github.com/github/spec-kit](https://github.com/github/spec-kit)
- **Spec Kit Documentation**: [https://github.com/github/spec-kit#readme](https://github.com/github/spec-kit#readme)
- **MCP Server README**: ../README.md
- **Contributing Guide**: ../docs/development/contributing.md

## Quick Reference

| Need to... | Read... |
|------------|---------|
| Understand project principles | `constitution.md` |
| Know what features exist | `specification.md` |
| Understand how it works | `implementation-plan.md` |
| Find work to do | `task-list.md` |
| Add a new tool | `implementation-plan.md` → Adding Tools |
| Set up authentication | `specification.md` → FR-7 |
| Write tests | `task-list.md` → T-001 through T-007 |
| Make architectural decision | `constitution.md` → Decision-Making Framework |
| Plan a sprint | `task-list.md` → Sprint Planning |
| Understand error handling | `implementation-plan.md` → Error Handling System |

## Getting Help

**For Spec Kit questions**:
- Read Spec Kit documentation: [https://github.com/github/spec-kit](https://github.com/github/spec-kit)
- Check Spec Kit examples in the repo

**For MCP Server questions**:
- Check the artifacts in `.specify/memory/`
- Read the documentation in the root directory
- Review code comments that reference Spec Kit sections

---

**Spec Kit Version**: 2.0.0
**MCP Server Version**: 2.0.0
**Last Updated**: 2025-11-16
**Maintained By**: OpenL MCP Server Team
