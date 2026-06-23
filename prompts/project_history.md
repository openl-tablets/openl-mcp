---
title: Project History
description: Guide for viewing a project's committed Git history with openl_repository_project_revisions and its local workspace changes with openl_list_project_local_changes, and when to use each
arguments:
  - name: projectId
    description: ID of the project
    required: false
---

## Summary

OpenL tracks two kinds of history:

- **Committed history** — the Git commit log of a project in a design repository. Read it with **openl_repository_project_revisions**.
- **Local workspace history** — uncommitted changes saved while the project is open. List it with **openl_list_project_local_changes** and roll back with **openl_restore_project_local_change**.

History applies only to projects in a design repository. For `repository: 'local'`, neither committed revisions nor local change history is available (local projects cannot be opened).

# Project History: **{projectId}**

{if projectId}
Use the tools below to inspect history for **{projectId}**.
{end if}

## Committed history — openl_repository_project_revisions

Use this for the project's Git commit log. It is read-only and does not require the project to be opened.

- Audit the change trail across the entire OpenL project
- See who committed what and when, across multiple Excel files
- Track team activity and review past saves/merges

Key arguments:
- `repository` — repository id or name (call **openl_list_repositories** first; both id and name are accepted)
- `projectName` — the project to inspect
- `branch` — optional, only for repositories that support branches
- `search` — optional filter on commit message or author
- `techRevs` — optional, include technical revisions (default: false)
- `page` / `size` — optional pagination (size default 50, max 200)

## Local workspace history — openl_list_project_local_changes

Use this for the uncommitted change history of a project you have open. It is session-based: call **openl_open_project** first, and it takes no `projectId` argument.

- Review versions saved locally before they are committed
- Find an earlier local version to recover from

To roll back, pass the `historyId` from the list response to **openl_restore_project_local_change** (this overwrites the current local state, so confirm before restoring).

## Choosing between them

- Need the committed Git log, authors, and commit hashes → **openl_repository_project_revisions**
- Need to inspect or undo uncommitted local edits in an open project → **openl_list_project_local_changes** / **openl_restore_project_local_change**

## OpenL Revision Info

Each revision from **openl_repository_project_revisions** includes:
- commitHash (Git SHA)
- Author, timestamp
- Branch, commit type (SAVE, MERGE, etc.)
- Files changed, tables changed
