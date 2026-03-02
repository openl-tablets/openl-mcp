---
name: file_history
description: Git-based version history for OpenL files with commit operations
arguments:
  - name: filePath
    description: Path of the file to view history for
    required: false
  - name: projectId
    description: ID of the project containing the file
    required: false
---

## Summary

**Track file changes with Git commit history**: Every save creates a Git commit with hash (not v1/v2). **openl_get_file_history**, **openl_download_file**, and **openl_revert_version** are temporarily unavailable on the server—use the OpenL Studio UI to view commit history, download older versions, and restore files. Git history is only supported for projects in a design repository; for `repository: 'local'` it is not available.

# OpenL File History (Git-Based Versioning)

{if filePath}
## File History: `{filePath}`
{end if}
{if projectId}

**Project**: {projectId}
{end if}

OpenL uses Git for version control. Every save/upload creates Git commit automatically.

## Version = Git Commit Hash
Versions are commit hashes (e.g., "7a3f2b1c"), NOT v1/v2/v3

## Common Operations (UI / manual fallbacks)

*openl_get_file_history, openl_download_file, openl_revert_version, and openl_compare_versions are temporarily unavailable on the server. Use the OpenL Studio UI or repository Git commands below.*

**VIEW history:** Open OpenL Studio UI → open project → file history for the file (or use repository: `git log -- <filePath>`).

**FIND specific date:** In OpenL Studio UI file history, filter by date; or use `git log` with date options to find the commit hash.

**DOWNLOAD old version:** Use OpenL Studio UI download action for the file at a given version, or in the repository run `git show <commitHash>:<filePath>` / `git checkout <commitHash> -- <filePath>`.

**COMPARE versions:** *openl_compare_versions is disabled.* Use OpenL Studio UI for version comparison (or `git diff <commit1> <commit2> -- <filePath>` in the repository).

**RECOVER deleted file:** In OpenL Studio UI, use file history to find the last SAVE commit before ERASE, then restore or download that version; or use repository Git to checkout the file from the last good commit.

**REVERT:** Use OpenL Studio UI restore/rollback for the file, or in the repository use your Git rollback procedure (e.g. revert commit or checkout and commit).

## OpenL Commit Types

- **SAVE**: Normal save operation
- **ARCHIVE**: File archived (soft delete)
- **RESTORE**: File restored from archive
- **ERASE**: Permanently deleted
- **MERGE**: Git branch merge

## Pagination
When file-history tools are available, API pagination uses `limit` (default 50) and `offset`. For UI or Git, use the interface’s own paging or log options.
