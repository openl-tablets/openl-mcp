---
title: Create Spreadsheet Tables
description: Detailed guide for creating Spreadsheet tables in OpenL Studio for multi-step calculations with formula syntax, JSON structure, and common mistakes
---

## Summary

**Spreadsheet Tables** are used for multi-step calculations with intermediate values, audit trails, and formula-based computations. Use when you need insurance premium calculations, financial computations with breakdown, or multi-stage pricing logic. Note: Excel formulas are NOT supported - use OpenL syntax instead.

# Creating Spreadsheet Tables in OpenL Studio

You are helping the user create a Spreadsheet table in OpenL Studio.

## SPREADSHEET TABLES (For Calculations)

**When to Use:**
- Multi-step calculations
- Need intermediate values
- Audit trail required
- Insurance premium calculations
- Financial computations with breakdown
- Multi-stage pricing logic
- Chaining multiple rule calls together

**Header Format:**
```text
Spreadsheet <ReturnType> spreadsheetName(<ParamType1> param1, ...)
```

**Return Types:**
- `SpreadsheetResult`: Returns entire calculated matrix (most common)
- Specific type (int, double, custom type): Returns final cell value

---

## Simple Spreadsheet Structure (Two Columns: Step + Formula)

The most common structure uses two columns: **Step** and **Formula**.

**Excel Structure:**
```text
| Spreadsheet SpreadsheetResult DeterminePolicyPremium (Policy policy) |
|----------------------------------------------------------------------|
| Step                  | Formula                                       |
|-----------------------|-----------------------------------------------|
| PolicyCalculation*    | = PolicyPremiumCalculation (policy)           |
| CalculatedPolicy      | = Policy ($PolicyCalculation)                 |
| RedistributedPolicy   | = PremiumRedistribution ($CalculatedPolicy)   |
| RecalculatedPolicy*   | = $RedistributedPolicy.$Validation.$RecalculatedPolicy |
```

---

## CRITICAL: Formula Column Syntax Rules

### 1. The "=" Sign Requirement

**Formula values MUST start with `=` when they contain:**
- Calls to other rules: `= RuleName (param)`
- Mathematical formulas: `= $Step1 * 1.5`
- Numeric calculations: `= 100 + 50`
- References to other steps: `= $OtherStep`

**Examples:**
```text
| Step          | Formula                              |
|---------------|--------------------------------------|
| BaseAmount    | = 1000                               |
| RiskFactor    | = CalculateRisk (policy)             |
| Premium       | = $BaseAmount * $RiskFactor          |
| FinalAmount   | = $Premium + $BaseAmount * 0.1       |
```

### 2. The "$" Sign for Step References

**Use `$` prefix to reference values from other steps:**
- `$StepName` - Reference value from another step
- `$StepName.$Property` - Access property of a step's result
- `$StepName.$Nested.$Property` - Access nested properties

**Examples:**
```text
| Step              | Formula                                    |
|-------------------|---------------------------------------------|
| PolicyCalc        | = PolicyPremiumCalculation (policy)         |
| Premium           | = $PolicyCalc.$premium                      |
| ValidationResult  | = $PolicyCalc.$Validation.$RecalculatedPolicy |
```

### 3. Asterisk (*) for Output Steps

**Add `*` at the end of step name to mark it as an output step:**
- Output steps are included in the SpreadsheetResult
- Steps without `*` are intermediate calculations (may be hidden in output)

**Example:**
```text
| Step              | Formula                              |
|-------------------|--------------------------------------|
| BaseCalc          | = CalculateBase (input)              |
| Adjustment        | = $BaseCalc * 1.2                    |
| FinalResult*      | = $Adjustment + 100                  |
```

---

## Calling Other Rules from Spreadsheet

You can call any other OpenL rule from within a spreadsheet step:

```text
| Step              | Formula                                    |
|-------------------|---------------------------------------------|
| PolicyCalc        | = PolicyPremiumCalculation (policy)         |
| ValidatedPolicy   | = ValidatePolicy ($PolicyCalc)              |
| Redistribution    | = PremiumRedistribution ($ValidatedPolicy)  |
```

**Syntax:** `= RuleName (parameter1, parameter2, ...)`

- Parameters can be input arguments or references to other steps
- Use `$StepName` to pass a step's result to another rule

---

## JSON Structure for Creating Spreadsheet

When creating a spreadsheet programmatically, use this JSON structure:

```json
{
  "tableType": "SimpleSpreadsheet",
  "kind": "Spreadsheet",
  "name": "DeterminePolicyPremium",
  "returnType": "SpreadsheetResult",
  "args": [
    {
      "name": "policy",
      "type": "Policy"
    }
  ],
  "steps": [
    {
      "name": "PolicyCalculation*",
      "value": "= PolicyPremiumCalculation (policy)"
    },
    {
      "name": "CalculatedPolicy",
      "value": "= Policy ($PolicyCalculation)"
    },
    {
      "name": "RedistributedPolicy",
      "value": "= PremiumRedistribution ($CalculatedPolicy)"
    },
    {
      "name": "RecalculatedPolicy*",
      "value": "= $RedistributedPolicy.$Validation.$RecalculatedPolicy"
    }
  ]
}
```

**JSON Fields:**
| Field | Description |
|-------|-------------|
| `tableType` | Use `"SimpleSpreadsheet"` for Step/Formula structure |
| `kind` | Always `"Spreadsheet"` |
| `name` | Name of the spreadsheet rule |
| `returnType` | Usually `"SpreadsheetResult"` or specific type |
| `args` | Array of input parameters with `name` and `type` |
| `steps` | Array of step objects with `name` and `value` |

**Step Object:**
| Field | Description |
|-------|-------------|
| `name` | Step name (add `*` suffix for output steps) |
| `value` | Formula starting with `=` for calculations/rule calls |

---

## Quick Reference: Formula Patterns

| Pattern | Example | Description |
|---------|---------|-------------|
| Rule call | `= RuleName (param)` | Call another rule |
| Step reference | `= $StepName` | Reference another step's value |
| Property access | `= $Step.$property` | Access property of step result |
| Math operation | `= $Step1 * $Step2` | Calculate using step values |
| Combined | `= $Step.$prop * 1.5` | Mix references and operations |
| Nested property | `= $A.$B.$C` | Access deeply nested value |

---

## Example Workflow

```text
User: "I need to calculate policy premium with validation"

AI Response:
1. Identify the calculation steps and rules to call
2. Create steps that chain rule calls together
3. Use $ references to pass results between steps
4. Mark final output steps with *
5. Return SpreadsheetResult for full breakdown
```

**Generated JSON:**
```json
{
  "tableType": "SimpleSpreadsheet",
  "kind": "Spreadsheet",
  "name": "CalculatePolicyPremium",
  "returnType": "SpreadsheetResult",
  "args": [
    { "name": "policy", "type": "Policy" }
  ],
  "steps": [
    { "name": "BasePremium", "value": "= CalculateBasePremium (policy)" },
    { "name": "RiskAdjustment", "value": "= CalculateRiskFactor ($BasePremium)" },
    { "name": "FinalPremium*", "value": "= $BasePremium.$amount * $RiskAdjustment" }
  ]
}
```

---

## Common Mistakes to Avoid

1. **Missing `=` sign**: Formula values must start with `=`
   - Wrong: `PolicyPremiumCalculation (policy)`
   - Correct: `= PolicyPremiumCalculation (policy)`

2. **Missing `$` for references**: Step references need `$` prefix
   - Wrong: `= BaseAmount * 1.5`
   - Correct: `= $BaseAmount * 1.5`

3. **Forgetting `*` for outputs**: Output steps should be marked
   - Intermediate: `TempCalc` (no asterisk)
   - Output: `FinalResult*` (with asterisk)

4. **Using Excel formulas**: OpenL does NOT support Excel formulas
   - Wrong: `=SUM(A1:A5)` (Excel syntax)
   - Correct: `= $Step1 + $Step2 + $Step3` (OpenL syntax)
