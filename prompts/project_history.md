---
name: project_history
description: OpenL project-level history and version control operations
arguments:
  - name: projectId
    description: ID of the project to view history for
    required: false
---

## Summary

**Project-wide audit trail**: **openl_get_project_history**, **openl_get_file_history**, and **openl_revert_version** are temporarily unavailable (disabled on the server). Do not invoke them. Use the OpenL Studio design UI—or manual inspection/rollback in the repository—to view project-wide commits, file-level history, and restore previous versions. Git history applies only to projects in a design repository; for `repository: 'local'` it is not available.

# OpenL Project History vs File History

{if projectId}
## Project History: **{projectId}**
{end if}

## Handler availability

**openl_get_project_history**, **openl_get_file_history**, and **openl_revert_version** are temporarily disabled. Use the OpenL Studio design UI or manual repository steps (e.g. Git log, checkout, or file inspection) for project audit, file history, and rollback. For `repository: 'local'`, project history is not available—use the UI if needed.

## When to use (via UI or manual fallback)

**Project-wide audit (normally openl_get_project_history):**
- Audit trail across entire OpenL project
- Find when change affected multiple Excel files
- Track team activity; compare project states at different commits; revert to stable commit  
→ Use OpenL Studio design UI or repository Git history.

**File-level history (normally openl_get_file_history):**
- Track single file changes; find who modified a file; compare versions; recover deleted file  
→ Use OpenL Studio design UI or manual file inspection/rollback in the repository.

## OpenL Commit Info

Each commit (when viewed via UI or repository) shows:
- commitHash (Git SHA)
- Author, timestamp
- Branch, commit type (SAVE, MERGE, etc.)
- Files changed, tables changed
