/**
 * TypeScript types for OpenL Studio REST API
 */

export interface OpenLConfig {
  baseUrl: string;
  // Personal Access Token Authentication
  personalAccessToken?: string;
  // Request timeout in milliseconds
  timeout?: number;
}

export interface ProjectId {
  repository: string;
  projectName: string;
}

export interface LockInfo {
  locked: boolean;
  lockedBy?: string;
  lockedAt?: string;
}

export type ProjectStatus =
  | "LOCAL"
  | "ARCHIVED"
  | "OPENED"
  | "VIEWING_VERSION"
  | "EDITING"
  | "CLOSED";

export interface ProjectViewModel {
  name: string;
  modifiedBy: string;
  modifiedAt: string;
  lockInfo?: LockInfo;
  branch?: string;
  revision?: string;
  path: string;
  // OpenL returns a string project ID (legacy servers may return object format)
  id: ProjectId | string;
  status: ProjectStatus;
  tags?: Record<string, string>;
  comment?: string;
  repository: string;
  selectedBranches?: string[];
}

/**
 * Response of the create-from-zip endpoint (PUT /repos/{repo}/projects/{name}).
 * The revision is the git commit SHA of the single FULL-changeset commit that
 * created the project.
 */
export interface CreateProjectResult {
  revision: string;
  /** Present only for repositories that support branches. */
  branch?: string;
}

/**
 * Request body for repository file copy/move operations
 * (POST /repos/{repo}/file-copy and /file-move). Paths are mount-relative.
 */
export interface FilePathPairRequest {
  sourcePath: string;
  destinationPath: string;
}

/**
 * A file or folder node returned by the Projects: Files (BETA) API
 * (folder listings, `view=meta`, and file-search). The base contract is the
 * path/name/type/basePath quartet; the backend additionally returns `extension`,
 * `size` and `lastModified` for files, so they are modelled here as optional.
 */
export interface FsNode {
  /** Project-relative path (e.g. 'folder/rules.xlsx'). */
  path: string;
  /** Simple file or folder name. */
  name: string;
  /** Resource type. */
  type: "file" | "folder";
  /**
   * Parent directory path, when provided. Project-relative for SUBTREE-scope
   * results; repository-relative for ANCESTORS-scope results (which cross the
   * project boundary).
   */
  basePath?: string;
  /** File extension without the dot (files only). */
  extension?: string;
  /** Size in bytes (files only). */
  size?: number;
  /** ISO-8601 last-modified timestamp (files only). */
  lastModified?: string;
  /**
   * Raw file content. The backend populates this for ANCESTORS-scope file-search
   * (which returns each matched file together with its content); it is absent for
   * SUBTREE listings/searches, which return metadata only.
   */
  content?: string;
}

/**
 * One AGENTS.md file in a project's resolved ancestry chain, as returned by
 * {@link OpenLClient.getProjectAgentsMd} (surfaced by the
 * `openl_get_project_agents_md` tool). The chain follows the AGENTS.md spec:
 * starting at the project (or a
 * sub-folder of it) and walking up to the repository root, the nearest file wins.
 * Proximity is carried by array order (nearest-first); the presentation layer
 * renders the files into a single document with that precedence applied.
 */
export interface AgentsFile {
  /**
   * Path relative to the REPOSITORY root (not the project), e.g.
   * 'monorepo/Project-1/AGENTS.md'. ANCESTORS search crosses the project boundary,
   * so paths are repo-relative to disambiguate files at different levels.
   */
  path: string;
  /** Raw markdown content of the file. */
  content: string;
  /** Size in bytes, when reported by the backend. */
  size?: number;
  /** ISO-8601 last-modified timestamp, when reported by the backend. */
  lastModified?: string;
}

/**
 * Search query body for POST /projects/{projectId}/file-search (FileSearchQuery).
 * All fields are optional; an empty body matches everything in scope.
 */
export interface FileSearchQuery {
  /** Ant-glob path pattern, e.g. all xlsx under rules. */
  pattern?: string;
  /** Case-insensitive content substring (full-text match). */
  content?: string;
  /** Filter by file extensions (without the dot). */
  extensions?: string[];
  /** Restrict to files, folders, or both. */
  type?: "FILE" | "FOLDER" | "ANY";
  /** SUBTREE (default) searches within the project; ANCESTORS walks up to the repo root. */
  scope?: "SUBTREE" | "ANCESTORS";
  /** Whether to descend into nested folders. */
  recursive?: boolean;
  /** Project-relative path to start the search from. */
  from?: string;
  /** Historical revision to search (SUBTREE scope only). */
  version?: string;
}

/**
 * Result of reading a single project file's bytes via the Projects: Files API.
 * Returned by {@link OpenLClient.readProjectFile} so the caller can decide how to
 * decode the payload (text vs base64) and whether the body was a file download or
 * a JSON listing/metadata response.
 */
export interface ProjectFileResponse {
  /** Raw response body. */
  data: Buffer;
  /** Response Content-Type header (lower-cased), if any. */
  contentType: string;
  /** Response Content-Disposition header, if any (present for file downloads). */
  contentDisposition: string;
}

export type TableType =
  // Decision Tables (most common - 5 variants)
  | "Rules"           // Standard decision table with explicit C/A/RET columns
  | "SimpleRules"     // Simplified decision table with positional matching
  | "SmartRules"      // Flexible decision table with smart parameter matching
  | "SimpleLookup"    // Two-dimensional lookup table
  | "SmartLookup"     // Two-dimensional lookup with smart matching
  // Spreadsheet (most common - calculations)
  | "Spreadsheet"     // Multi-step calculations with formulas
  | "SimpleSpreadsheet" // Simplified spreadsheet format
  // Other types (rarely used)
  | "Method"          // Custom Java-like methods
  | "TBasic"          // Complex flow control algorithms
  | "Data"            // Relational data tables
  | "Datatype"        // Custom data structure definitions
  | "Vocabulary"      // Datatype vocabulary table
  | "Test"            // Unit test tables
  | "RawSource"       // Raw table source format
  | "Run"             // Test suite execution
  | "Properties"      // Dimension properties configuration
  | "Configuration";  // Environment settings

export type TableKind =
  | "Rules"
  | "Spreadsheet"
  | "Datatype"
  | "Data"
  | "Test"
  | "TBasic"
  | "Column Match"
  | "Method"
  | "Run"
  | "Constants"
  | "Conditions"
  | "Actions"
  | "Returns"
  | "Environment"
  | "Properties"
  | "Other";

export interface SummaryTableView {
  id: string;
  tableType: TableType;
  kind: TableKind;
  name: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  properties?: Record<string, any>;
  returnType?: string;
  signature?: string;
  file: string;
  pos: string;
}

/**
 * Common fields shared by every concrete table view returned from
 * `GET /projects/{id}/tables/{tableId}` (parsed) or sent on
 * create/update. Mirrors the fields that appear on every subtype in the
 * studio OpenAPI under `EditableTableView` discriminator (Datatype,
 * SimpleRules, Spreadsheet, RawTableView, …): `id`, `tableType`, `kind`,
 * `name`, `properties`, `pos`, `messages`. `file` and `signature`/`returnType`
 * are present on the `SummaryTableView` side too — included here for
 * convenience since the same TypeScript type is reused for list and detail.
 *
 * `id` is optional because create-table requests are allowed to omit it
 * (the server assigns one).
 */
export interface EditableTableView {
  id?: string;
  tableType: TableType;
  kind: TableKind;
  name: string;
  /** Custom dimension/business properties (state, lob, effectiveDate, …). */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  properties?: Record<string, any>;
  /** Position of the table within the source file (e.g. cell address). */
  pos?: string;
  /** File the table is defined in. Populated on read; ignored on create. */
  file?: string;
  /**
   * Compilation messages attached to this table (errors / warnings / info).
   * Read-only — server-populated; ignored on update/create.
   */
  messages?: DetailedMessageDescription[];
}

/** Append data to project table (OpenAPI 3.0.1) - polymorphic type based on tableType */
export type AppendTableView =
  | {
      /** Table type: Datatype */
      tableType: "Datatype";
      /** Table fields */
      fields: Array<{
        /** Field name (required) */
        name: string;
        /** Field type (required) */
        type: string;
        /** Required flag */
        required?: boolean;
        /** Default value */
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        defaultValue?: any;
      }>;
    }
  | {
      /** Table type: SimpleRules */
      tableType: "SimpleRules";
      /** Array of rule objects to append */
      rules: Array<Record<string, any>>;
    }
  | {
      /** Table type: SimpleSpreadsheet */
      tableType: "SimpleSpreadsheet";
      /** Array of spreadsheet step objects to append */
      steps: Array<any>;
    }
  | {
      /** Table type: SmartRules */
      tableType: "SmartRules";
      /** Array of rule objects to append */
      rules: Array<Record<string, any>>;
    }
  | {
      /** Table type: Vocabulary */
      tableType: "Vocabulary";
      /** Array of vocabulary value objects to append */
      values: Array<any>;
    }
  | {
      /** Table type: RawSource */
      tableType: "RawSource";
      /** Array of rows to append; each row is an array of cell objects (e.g. { value: string, colspan?: number } or { covered?: boolean }) */
      rows: Array<Array<Record<string, unknown>>>;
    };

export interface DatatypeView extends EditableTableView {
  fields?: Array<{
    name: string;
    type: string;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    defaultValue?: any;
  }>;
  parentType?: string;
}

export interface SimpleRulesView extends EditableTableView {
  rules?: Array<{
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    conditions?: Record<string, any>;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    actions?: Record<string, any>;
  }>;
  conditionColumns?: string[];
  actionColumns?: string[];
}

export interface RepositoryInfo {
  aclId: string;
  /** Repository ID */
  id: string;
  /** Repository name */
  name: string;
}

/** Repository features (from OpenAPI) */
export interface RepositoryFeatures {
  branches: boolean;
  searchable: boolean;
}

/** Project revision from repository history (from OpenAPI) */
export interface ProjectRevision {
  revisionNo: string;
  shortRevisionNo?: string;
  createdAt: string;
  fullComment: string;
  author?: {
    name: string;
    email?: string;
  };
  deleted: boolean;
  technicalRevision: boolean;
  commentParts?: string[];
}

export interface FileData {
  name: string;
  version?: string;
  author?: string;
  modifiedAt?: string;
  comment?: string;
  size?: number;
  branch?: string;
  deleted?: boolean;
}

export interface ProjectHistoryItem extends FileData {
  version: string;
  author: string;
  modifiedAt: string;
  comment: string;
}

export interface DeploymentInfo {
  id: string;
  name: string;
  projectName: string;
  projectVersion?: string;
  repository: string;
  status: string;
  deployedAt?: string;
  deployedBy?: string;
}

/** Deployment view model (short version from OpenAPI 3.0.1) */
export interface DeploymentViewModel_Short {
  id: string;
  name: string;
  projectId: string;
  productionRepositoryId: string;
  deployedAt?: string;
  deployedBy?: string;
  status?: string;
}

/** Deploy project request (OpenAPI 3.0.1) */
export interface DeployProjectRequest {
  projectId: string;              // Project ID from backend
  deploymentName: string;         // Name for the deployment
  productionRepositoryId: string;
  comment?: string;
}

/** Redeploy project request (OpenAPI 3.0.1) */
export interface RedeployProjectRequest {
  projectId: string;              // Project ID from backend
  comment?: string;
}

export interface ProjectInfo {
  name: string;
  repository: string;
  path: string;
  branch?: string;
  modules?: Array<{
    name: string;
    rulesRootPath?: string;
  }>;
  dependencies?: Array<{
    name: string;
    autoIncluded?: boolean;
  }>;
  classpath?: string[];
  tags?: Record<string, string>;
}

/** Branch create request (OpenAPI 3.0.1) */
export interface BranchCreateRequest {
  branch: string;   // Branch name (required)
  revision?: string;    // Revision to branch from (optional)
}

/** Project status update model (request body for PATCH /projects/{id}) */
export interface ProjectStatusUpdateModel {
  /** Only OPENED and CLOSED can be set by the client; LOCAL, ARCHIVED, VIEWING_VERSION, EDITING are set automatically by the backend */
  status?: "OPENED" | "CLOSED";
  /** Additional fields may be supported by the API */
  branch?: string;
  revision?: string;
  comment?: string;
}

// =============================================================================
// Type Aliases for API Client
// =============================================================================

/** Repository information */
export type Repository = RepositoryInfo;

/** Project summary for list operations */
export type ProjectSummary = ProjectViewModel;

/** Full project details */
export type Project = ProjectViewModel;

/** Table metadata for list operations */
export type TableMetadata = SummaryTableView;

/** Full table view with data (parsed form) */
export type TableView = EditableTableView;

/**
 * A single cell in a raw table view's 2D source matrix.
 *
 * Mirrors `RawTableCell` in the studio OpenAPI. `value` is typed as `unknown`
 * because the backend serializes whatever JSON value the cell holds (string,
 * number, boolean, null). `cell` is the A1-notation address (e.g. `B3`) and
 * matches the cell address that compilation messages reference — absent for
 * covered cells.
 */
export interface RawTableCell {
  /** A1-notation cell address (e.g. `B3`). Read-only; absent for covered cells. */
  cell?: string;
  value?: unknown;
  /** Number of columns this cell spans (>=2 when merging; absent otherwise). */
  colspan?: number;
  /** Number of rows this cell spans (>=2 when merging; absent otherwise). */
  rowspan?: number;
  /** True when this cell is masked by another cell's span. */
  covered?: boolean;
}

/**
 * Raw 2D view of a table — the un-parsed cell matrix used when `raw=true` on
 * `openl_get_table`. Inherits the common `EditableTableView` fields (id, kind,
 * name, properties, pos, messages) and adds the `source` matrix. Mirrors
 * `RawTableView` in the studio OpenAPI (`tableType: "RawSource"`).
 */
export interface RawTableView extends EditableTableView {
  source: RawTableCell[][];
}

/** Filters for listing projects (OpenAPI 3.0.1) */
export interface ProjectFilters {
  /** Repository ID */
  repository?: string;
  /** Project status */
  status?: string;
  /** Project tags - must start with `tags.` prefix, e.g., { "tags.insurance.home": "value" } */
  tags?: Record<string, string>;
  /** Pagination: page number (0-based, default: 0) */
  page?: number;
  /** Pagination: page size (default: 50) */
  size?: number;
  /** Pagination: offset (alternative to page, for backward compatibility) */
  offset?: number;
  /** Pagination: limit (alternative to size, for backward compatibility) */
  limit?: number;
}

// =============================================================================
// Testing & Validation Types
// =============================================================================

/** Test unit execution result (from OpenAPI) */
export interface TestUnitExecutionResult {
  name: string;
  status: "PASSED" | "FAILED" | "ERROR";
  executionTimeMs: number;
  message?: string;
  failureDetails?: string;
}

/** Test case execution result (from OpenAPI) */
export interface TestCaseExecutionResult {
  name: string;
  tableId: string;
  description?: string;
  executionTimeMs: number;
  numberOfTests: number;
  numberOfFailures: number;
  testUnits: TestUnitExecutionResult[];
}

/** Tests execution summary (from OpenAPI) */
export interface TestsExecutionSummary {
  testCases: TestCaseExecutionResult[];
  executionTimeMs: number;
  numberOfTests: number; // Total number of tests (all tests)
  numberOfFailures: number; // Number of failed tests
  pageNumber?: number;
  pageSize?: number;
  numberOfElements?: number; // Page size (elements per page for pagination)
  totalElements?: number;
  totalPages?: number;
}

/** Test execution start response */
export interface TestExecutionStartResponse {
  status: "started" | "accepted";
  projectId: string;
  tableId?: string;
  testRanges?: string;
  projectWasOpened?: boolean;
  message: string;
}

/** Test results summary (without testCases array) */
export interface TestResultsSummary {
  executionTimeMs: number;
  numberOfTests: number;
  numberOfFailures: number;
  numberOfPassed: number;
}

/** Project validation result */
export interface ValidationResult {
  valid: boolean;
  errors: ValidationError[];
  warnings: ValidationWarning[];
}

/** Validation error */
export interface ValidationError {
  severity: "ERROR";
  message: string;
  location?: string;
  table?: string;
  line?: number;
}

/** Validation warning */
export interface ValidationWarning {
  severity: "WARNING";
  message: string;
  location?: string;
  table?: string;
}

// =============================================================================
// Phase 1: New Types for Extended Functionality
// =============================================================================

/** Comprehensive project details combining Project and ProjectInfo */
export interface ComprehensiveProject extends ProjectViewModel {
  /** Modules in the project */
  modules?: Array<{
    name: string;
    rulesRootPath?: string;
  }>;
  /** Project dependencies */
  dependencies?: Array<{
    name: string;
    autoIncluded?: boolean;
  }>;
  /** Classpath entries */
  classpath?: string[];
}

/** Filters for listing tables */
export interface TableFilters {
  /** Filter by table kinds (array of strings). Valid values: 'Rules', 'Spreadsheet', 'Datatype', 'Data', 'Test', 'TBasic', 'Column Match', 'Method', 'Run', 'Constants', 'Conditions', 'Actions', 'Returns', 'Environment', 'Properties', 'Other' */
  kind?: string[];
  /** Filter by table name fragment */
  name?: string;
  /** Filter by project properties (will be prefixed with 'properties.' in query string) */
  properties?: Record<string, string>;
  /** Pagination: page number (0-based, default: 0) */
  page?: number;
  /** Pagination: page size (default: 50) */
  size?: number;
  /** Pagination: offset (alternative to page, for backward compatibility) */
  offset?: number;
  /** Pagination: limit (alternative to size, for backward compatibility) */
  limit?: number;
}

/** Save project result. API returns 204 No Content and does not provide commit hash, version, author, or timestamp. */
export interface SaveProjectResult {
  success: boolean;
  message: string;
  /** Present when success is false and validation failed before save */
  validationErrors?: ValidationError[];
}

/** Rule creation request */
export interface CreateRuleRequest {
  name: string;
  tableType: TableType;           // Type of table to create
  returnType?: string;            // Return type (e.g., 'int', 'String', 'SpreadsheetResult')
  parameters?: Array<{            // Method parameters
    type: string;                 // Parameter type (e.g., 'String', 'int', 'Policy')
    name: string;                 // Parameter name (e.g., 'driverType', 'age')
  }>;
  file?: string;                  // Target Excel file (optional, uses default if not specified)
  properties?: Record<string, unknown>;  // Dimension properties (state, lob, effectiveDate, etc.)
  comment?: string;               // Commit comment
}

/** Rule creation result */
export interface CreateRuleResult {
  success: boolean;
  tableId?: string;
  tableName?: string;
  tableType?: TableType;
  file?: string;
  message?: string;
}

/** Create new project table request (BETA API) */
export interface CreateNewTableRequest {
  /** Name of the module where the table will be created (required) */
  moduleName: string;
  /** Name of the sheet where the table will be created (optional, uses table name if not provided) */
  sheetName?: string;
  /** Complete table structure (EditableTableView) */
  table: EditableTableView;
}

// =============================================================================
// Phase 2: Testing & Validation Types
// =============================================================================

// =============================================================================
// Phase 3: Versioning & Execution Types
// =============================================================================

// =============================================================================
// Phase 4: Advanced Features
// =============================================================================

// =============================================================================
// Phase 2: Git Version History Types
// =============================================================================

/** Commit type from OpenL operations */
export type CommitType = "SAVE" | "ARCHIVE" | "RESTORE" | "ERASE" | "MERGE";

/** Get project history request */
export interface GetProjectHistoryRequest {
  projectId: string;
  page?: number;        // Page number (default: 0, min: 0)
  size?: number;        // Page size (default: 50, min: 1)
  search?: string;      // Regex search term
  techRevs?: boolean;   // Include non-project revisions (default: false)
  branch?: string;      // Optional: specific branch (default: current branch)
}

/** Project revision (short version from OpenAPI 3.0.1) */
export interface ProjectRevision_Short {
  commitHash: string;
  version?: string;     // Alias for commitHash
  author: { name: string; email: string };
  modifiedAt: string;   // ISO timestamp
  comment: string;
  commitType?: CommitType;
  filesChanged?: number;
  tablesChanged?: number;
}

/** Generic paginated response */
export interface PageResponse<T> {
  content: T[];
  numberOfElements: number;
  pageNumber: number;
  pageSize: number;
  total?: number; // Total number of items (can be null if unknown)
  totalElements?: number; // Alias for total (for consistency with Spring)
  totalPages?: number; // Calculated as Math.ceil(total / pageSize)
}

/** Paginated response for project history (OpenAPI 3.0.1) */
export interface PageResponseProjectRevision_Short {
  content: ProjectRevision_Short[];
  numberOfElements: number;
  pageNumber: number;
  pageSize: number;
  totalElements?: number;
  totalPages?: number;
}

/** Project history commit entry */
export interface ProjectHistoryCommit {
  commitHash: string;
  author: { name: string; email: string };
  timestamp: string;
  comment: string;
  commitType: CommitType;
  filesChanged: number;
  tablesChanged?: number;
}

/** Get project history result */
export interface GetProjectHistoryResult {
  projectId: string;
  branch: string;
  commits: ProjectHistoryCommit[];
  total: number;
  hasMore: boolean;
}

// =============================================================================
// Project Status Types (post-compilation snapshot)
// =============================================================================

/**
 * Project compilation state.
 *
 * Mirrors the backend's
 * `org.openl.studio.projects.model.project.status.CompileState` enum, which
 * is serialized as lowercase via `@JsonProperty` on each constant.
 */
export type CompileState = "idle" | "compiling" | "ok" | "warnings" | "errors";

/** Source-location discriminator. Backend has `TableMessageSource` and `ModuleMessageSource` variants; intentionally typed loosely to avoid coupling. */
export type MessageSource = Record<string, unknown>;

/**
 * Compilation message. The backend flattens `MessageDescription`
 * (`id`/`summary`/`severity`) onto this type via `@JsonUnwrapped`, so those
 * fields appear at the top level alongside `location` and `stacktrace`.
 */
export interface DetailedMessageDescription {
  id?: number;
  summary?: string;
  severity?: "ERROR" | "WARN" | "INFO";
  location?: MessageSource;
  stacktrace?: boolean;
}

export interface CompilationMessages {
  items: DetailedMessageDescription[];
  total: number;
  errors: number;
  warnings: number;
}

export interface CompilationModules {
  total: number;
  compiled: number;
  compiledModules?: string[];
}

export interface CompilationTests {
  total: number;
}

export interface CompilationDetails {
  messages: CompilationMessages;
  modules: CompilationModules;
  tests: CompilationTests;
}

export interface ProjectModifiedBy {
  author?: string;
  /** ISO-8601 timestamp serialized from `ZonedDateTime`. */
  date?: string;
}

/**
 * Wire-level change type as serialized by the studio. The Java
 * `org.openl.studio.projects.model.project.status.ChangeType` enum is
 * annotated with `@JsonProperty("added")` / `"modified"` / `"deleted"`, so
 * the values on the wire are lowercase — matching how `CompileState` is
 * serialized.
 */
export type FileChangeType = "added" | "modified" | "deleted";

export interface FileChange {
  /** `<projectRealPath>/<file>` (forward slashes), matching the merge API. */
  path: string;
  type: FileChangeType;
}

export interface PendingChanges {
  total: number;
  files: FileChange[];
}

/**
 * Post-compilation project status returned by `GET /projects/{id}/status`.
 *
 * Named `ProjectStatusView` to avoid collision with the existing
 * {@link ProjectStatus} string-enum that represents project lifecycle states
 * (OPENED / CLOSED / EDITING / …).
 */
export interface ProjectStatusView {
  projectId: ProjectId | string;
  /** Present only for repositories that support branches. */
  branch?: string;
  revision?: string;
  compileState: CompileState;
  lastModifiedBy?: ProjectModifiedBy;
  /** Omitted when no compilation has been registered yet (e.g. `compileState: "idle"`). */
  compilation?: CompilationDetails;
  /** Omitted when the working copy is clean. */
  pendingChanges?: PendingChanges;
}

// =============================================================================
// Trace API Types (BETA)
// =============================================================================

/** Trace parameter value (input, context, or result) - may be lazy-loaded */
export interface TraceParameterValue {
  name: string;
  description: string;
  lazy: boolean;
  parameterId?: number | null;
  value?: unknown;
  schema?: object;
}

/** Trace node view - tree node with optional detail fields */
export interface TraceNodeView {
  key: number;
  title: string;
  tooltip: string;
  type: string;
  lazy: boolean;
  extraClasses: string;
  error?: boolean;
  parameters?: TraceParameterValue[];
  context?: TraceParameterValue;
  result?: TraceParameterValue;
  errors?: Array<{ severity: string; summary: string; detail?: string; sourceLocation?: string }>;
}

/** Start trace request - tableId required; for regular methods use inputJson, for test suite use testRanges */
export interface StartTraceRequest {
  projectId: string;
  tableId: string;
  testRanges?: string;
  fromModule?: string;
  inputJson?: string | object;
}

// =============================================================================
// API Error Response Types
// =============================================================================

/** Error detail in API error response (for 400 status) */
export interface ApiErrorDetail {
  code?: string;
  message?: string;
}

/** Field validation error in API error response (for 400 status) */
export interface ApiFieldError {
  code?: string;
  field?: string;
  message?: string;
  rejectedValue?: unknown;
}

/** Extracted error information from API response */
export interface ExtractedErrorInfo {
  code?: string;
  message?: string;
  errors?: ApiErrorDetail[];
  fields?: ApiFieldError[];
  rawResponse?: unknown; // Original response data if structure doesn't match expected formats
}

