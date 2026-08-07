---
title: Define Datatypes and Vocabularies
description: Create and edit Datatype and Vocabulary tables through raw workbook source
---

## Summary

Datatype and Vocabulary are semantic OpenL table kinds. MCP reads and writes
their content only as `RawSource`; typed `fields` or `values` payloads are not
supported because they cannot preserve the complete workbook structure.

## Workflow

1. Load the bundled Datatype/Vocabulary specification and inspect an existing
   example with `openl_get_table` when available.
2. Represent headers, field/value rows, type declarations, defaults,
   inheritance, blanks, and merges in the exact `source` matrix required by the
   guide.
3. Create through `openl_create_project_table` with
   `{ tableType: "RawSource", name, source }`.
4. Add or change fields/values using raw row/cell actions. A full replacement
   must round-trip the complete object returned by `openl_get_table` through
   `openl_update_table`.
5. Compile dependent rules and run tests before saving.

Do not introduce `DatatypeAppend`, `VocabularyAppend`, or editable typed table
schemas. For repository `local`, edit/test directly without open/save.
