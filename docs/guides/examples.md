# Usage Examples

Once your client is connected (see [Quick Start](quick-start.md)), you work with OpenL Studio by chatting in plain
language. Claude calls the right OpenL tools for you. Below are things you can ask, grouped by task.

> **Tip:** For Git-backed projects, ask Claude to **open** the project before editing its tables. Local projects
> are always editable.

## Explore repositories and projects

Ask Claude:

```text
List all OpenL Studio repositories
Show me all projects in OpenL Studio
Show me OPENED projects in the 'design' repository
Show me projects tagged 'production'
Show me the first 10 projects in the 'design' repository
Get details about the 'insurance-rules' project
Show the structure of 'insurance-rules' — modules and dependencies
```

A project list comes back like this:

```markdown
# Projects in repository: design

## insurance-rules
- Status: OPENED
- Modified: 2025-11-15 14:30 by john.doe
- Branch: main
- Tags: production, v2.3.1
```

Ask for any answer "in JSON" or "in markdown" — Claude passes the format to the tool.

## Work with rules and tables

```text
List all tables in the 'insurance-rules' project
Show me the 'CalculatePremium' table
What does the 'Policy' datatype contain?
Add a rule to 'CalculatePremium' for motorcycles with a $900 premium
```

A table list shows each table's id, type, and name:

```json
[
  { "id": "Rules.xls_1234", "kind": "Rules", "name": "CalculatePremium",
    "signature": "Double CalculatePremium(String vehicleType, Integer age)" },
  { "id": "Rules.xls_5678", "kind": "Datatype", "name": "Policy" }
]
```

A decision table renders like this:

```markdown
# CalculatePremium

| Vehicle Type | Age  | Premium |
|--------------|------|---------|
| Car          | <25  | 1200    |
| Car          | ≥25  | 800     |
| Motorcycle   | <25  | 900     |
```

**Table types you may see:** decision tables (Rules, SimpleRules, SmartRules, Lookups), Spreadsheets, Datatypes,
Methods, Test tables, and Data tables.

When you ask for a change, Claude reads the current table, edits it, and saves it with a commit comment.

## Run tests

```text
Run all tests for 'insurance-rules' and show the results
Run tests for the 'CalculatePremium' table
Show a brief test summary for 'insurance-rules'
Run only the failed tests
Run tests 1-3 and 5 for the 'Test_CalculatePremium' table
```

Notes:

- A brief summary gives pass/fail counts without per-test detail — good for a quick check.
- Results are paged **by test table**, not by individual test case: one page lists several tables, each with its own
  tests.

## Version control

```text
Show the version history of 'insurance-rules'
What branches exist in the 'design' repository?
Create a branch 'feature/new-premium-logic' for 'insurance-rules'
```

## Deploy

```text
Show me all deployed projects
Deploy 'insurance-rules' from 'design' to the 'production' repository
Deploy version 'v2.3.1' of 'insurance-rules' to production
```

## Example conversations

**Change a rule**

```text
You:    Increase the car premium to $1400 for drivers under 25.
Claude: [opens the project, finds CalculatePremium, reads it]
        The current rule is $1200 for cars, drivers under 25. I'll change it to $1400.
        [updates the table and saves]
        Done — committed with "Raise young-driver car premium to $1400".
```

**Deploy with a check first**

```text
You:    Deploy the latest insurance-rules to production.
Claude: [reads the project status and latest change]
        Latest change: "Finalized Q4 premium updates", 2 hours ago by john.doe.
        Deploy insurance-rules (design → production)?
You:    Yes.
Claude: [deploys] Done — insurance-rules is live in production.
```

## More things you can ask

```text
List all decision tables across projects whose name contains 'premium'
Compare the 'Vehicle' datatype between 'auto-insurance' and 'fleet-insurance'
Add a 'discountPercentage' field to the 'Policy' datatype
Generate documentation for all tables in 'insurance-rules'
```

## Tips

- **Be specific** — name the project, table, and repository.
- **Open before editing** Git-backed projects; **save** with a clear comment; **close** with save or discard.
- **Review before deploy** — ask Claude to show the change and run tests first.
- **Use branches** for experiments.
