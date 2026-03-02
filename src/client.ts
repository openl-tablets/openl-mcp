/**
 * OpenL Studio API Client
 *
 * Provides a high-level interface for interacting with OpenL Studio REST API.
 * Handles all HTTP communication, error handling, and response parsing.
 */

import axios, { AxiosInstance } from "axios";
import type * as Types from "./types.js";
import { AuthenticationManager } from "./auth.js";
import { DEFAULTS, ERROR_LOCAL_REPOSITORY, HEADERS, REPOSITORY_LOCAL } from "./constants.js";
import {
  validateTimeout,
  sanitizeError,
  normalizeOpenLBaseUrl,
} from "./utils.js";

/**
 * Client for OpenL Studio REST API
 *
 * Usage:
 * ```typescript
 * const client = new OpenLClient({
 *   baseUrl: "http://localhost:8080",
 *   username: "admin",
 *   password: "admin"
 * });
 *
 * const projects = await client.listProjects();
 * ```
 */
export class OpenLClient {
  private baseUrl: string;
  private axiosInstance: AxiosInstance;
  private authManager: AuthenticationManager;
  private repositoriesCache: Types.Repository[] | null = null;
  private jsessionId: string | null = null; // Store JSESSIONID cookie for session management
  private testExecutionHeaders: Map<string, Record<string, string>> = new Map(); // Store headers for test execution sessions

  /**
   * Create a new OpenL Studio API client
   *
   * @param config - Client configuration including base URL and authentication
   */
  constructor(config: Types.OpenLConfig) {
    this.baseUrl = normalizeOpenLBaseUrl(config.baseUrl);

    // Validate and set timeout
    const timeout = validateTimeout(config.timeout, DEFAULTS.TIMEOUT);

    // Create Axios instance with default configuration
    this.axiosInstance = axios.create({
      baseURL: this.baseUrl,
      timeout,
      headers: {
        "Content-Type": "application/json",
        "Accept": "application/json",
      },
    });

    // Setup authentication
    this.authManager = new AuthenticationManager(config);
    this.authManager.setupInterceptors(this.axiosInstance);

    // Setup Client Document ID for request tracking (audit/debug)
    this.setupClientDocumentIdInterceptor();

    // Setup cookie management: extract JSESSIONID from responses and add to requests
    this.setupCookieInterceptors();
  }

  /**
   * Add Client-Document-Id header from OPENL_CLIENT_DOCUMENT_ID when set.
   * Used for request tracking in audit and debugging.
   */
  private setupClientDocumentIdInterceptor(): void {
    this.axiosInstance.interceptors.request.use(
      (config) => {
        const clientDocumentId = process.env.OPENL_CLIENT_DOCUMENT_ID;
        if (clientDocumentId && config.headers) {
          config.headers[HEADERS.CLIENT_DOCUMENT_ID] = clientDocumentId;
        }
        return config;
      },
      (error) => Promise.reject(error)
    );
  }

  /**
   * Setup interceptors to automatically handle JSESSIONID cookies
   * Extracts JSESSIONID from set-cookie headers and adds it to all subsequent requests
   */
  private setupCookieInterceptors(): void {
    // Response interceptor: Extract JSESSIONID from set-cookie headers
    this.axiosInstance.interceptors.response.use(
      (response) => {
        // Extract JSESSIONID from set-cookie header if present
        const setCookieHeader = response.headers['set-cookie'];
        if (setCookieHeader) {
          const cookies = Array.isArray(setCookieHeader) ? setCookieHeader : [setCookieHeader];
          for (const cookie of cookies) {
            const jsessionMatch = cookie.match(/JSESSIONID=([^;]+)/);
            if (jsessionMatch) {
              this.jsessionId = jsessionMatch[1];
              break;
            }
          }
        }
        return response;
      },
      (error) => Promise.reject(error)
    );

    // Request interceptor: Add JSESSIONID to Cookie header if available
    this.axiosInstance.interceptors.request.use(
      (config) => {
        if (this.jsessionId && config.headers) {
          // Check if Cookie header already exists
          const existingCookie = config.headers['Cookie'] || config.headers['cookie'];
          if (existingCookie) {
            // Append JSESSIONID if not already present
            if (!existingCookie.includes('JSESSIONID=')) {
              config.headers['Cookie'] = `${existingCookie}; JSESSIONID=${this.jsessionId}`;
            }
          } else {
            // Set Cookie header with JSESSIONID
            config.headers['Cookie'] = `JSESSIONID=${this.jsessionId}`;
          }
        }
        return config;
      },
      (error) => Promise.reject(error)
    );
  }

  /**
   * Get the base URL of the OpenL Studio instance
   */
  public getBaseUrl(): string {
    return this.baseUrl;
  }

  /**
   * Get the current authentication method
   */
  public getAuthMethod(): string {
    return this.authManager.getAuthMethod();
  }

  // =============================================================================
  // Repository Management
  // =============================================================================

  /**
   * List all design repositories
   *
   * @param useCache - Whether to use cached repositories (default: true)
   * @returns Array of repository information
   */
  async listRepositories(useCache: boolean = true): Promise<Types.Repository[]> {
    if (useCache && this.repositoriesCache !== null) {
      return this.repositoriesCache;
    }
    
    const response = await this.axiosInstance.get<Types.Repository[]>(
      "/repos"
    );
    this.repositoriesCache = response.data;
    return response.data;
  }

  /**
   * Map repository name to repository ID
   * 
   * This function allows users to work with repository names (user-friendly)
   * while the server uses repository IDs internally for API calls.
   * 
   * @param repositoryName - Repository name (e.g., "Design Repository")
   * @returns Repository ID (e.g., "design-repo")
   * @throws Error if repository name not found
   */
  async getRepositoryIdByName(repositoryName: string): Promise<string> {
    const repositories = await this.listRepositories();
    const repository = repositories.find(r => r.name === repositoryName);
    
    if (!repository) {
      const availableNames = repositories.map(r => r.name).join(", ");
      throw new Error(
        `Repository with name "${repositoryName}" not found. ` +
        `Available repositories: ${availableNames || "none"}. ` +
        `Use openl_list_repositories() to see all available repositories.`
      );
    }
    
    return repository.id;
  }

  /**
   * Map repository ID to repository name
   * 
   * @param repositoryId - Repository ID (e.g., "design-repo")
   * @returns Repository name (e.g., "Design Repository")
   * @throws Error if repository ID not found
   */
  async getRepositoryNameById(repositoryId: string): Promise<string> {
    const repositories = await this.listRepositories();
    const repository = repositories.find(r => r.id === repositoryId);
    
    if (!repository) {
      const availableIds = repositories.map(r => r.id).join(", ");
      throw new Error(
        `Repository with ID "${repositoryId}" not found. ` +
        `Available repository IDs: ${availableIds || "none"}. ` +
        `Use openl_list_repositories() to see all available repositories.`
      );
    }
    
    return repository.name;
  }

  /**
   * Clear repositories cache (useful after repository changes)
   */
  clearRepositoriesCache(): void {
    this.repositoriesCache = null;
  }

  /**
   * List branches in a repository
   *
   * @param repository - Repository name
   * @returns Array of branch names
   */
  async listBranches(repository: string): Promise<string[]> {
    const response = await this.axiosInstance.get<string[]>(
      `/repos/${encodeURIComponent(repository)}/branches`
    );
    return response.data;
  }

  /**
   * Get repository features (branching support, searchable, etc.)
   *
   * @param repository - Repository ID
   * @returns Repository features
   */
  async getRepositoryFeatures(repository: string): Promise<Types.RepositoryFeatures> {
    const response = await this.axiosInstance.get<Types.RepositoryFeatures>(
      `/repos/${encodeURIComponent(repository)}/features`
    );
    return response.data;
  }

  /**
   * List deployment repositories
   *
   * @param useCache - Whether to use cached repositories (default: true)
   * @returns Array of deployment repository information
   */
  async listDeployRepositories(_useCache: boolean = true): Promise<Types.Repository[]> {
    // Note: We could cache this separately, but for simplicity, we'll fetch each time
    // since deployment repositories change less frequently
    const response = await this.axiosInstance.get<Types.Repository[]>(
      "/production-repos"
    );
    return response.data;
  }

  /**
   * Map production repository name to repository ID
   * 
   * This function allows users to work with production repository names (user-friendly)
   * while the server uses repository IDs internally for API calls.
   * 
   * @param repositoryName - Production repository name (e.g., "Production Deployment")
   * @returns Repository ID (e.g., "production-deploy")
   * @throws Error if repository name not found
   */
  async getProductionRepositoryIdByName(repositoryName: string): Promise<string> {
    const repositories = await this.listDeployRepositories();
    const repository = repositories.find(r => r.name === repositoryName);
    
    if (!repository) {
      const availableNames = repositories.map(r => r.name).join(", ");
      throw new Error(
        `Production repository with name "${repositoryName}" not found. ` +
        `Available production repositories: ${availableNames || "none"}. ` +
        `Use openl_list_deploy_repositories() to see all available production repositories.`
      );
    }
    
    return repository.id;
  }

  /**
   * Get project revision history from repository
   *
   * @param repository - Repository ID
   * @param projectName - Project name
   * @param options - Query options (branch, search, pagination, etc.)
   * @returns Paginated project revisions
   */
  async getProjectRevisions(
    repository: string,
    projectName: string,
    options?: {
      branch?: string;
      search?: string;
      techRevs?: boolean;
      page?: number;
      size?: number;
    }
  ): Promise<Types.PageResponse<Types.ProjectRevision>> {
    const params: Record<string, string | number | boolean> = {};
    if (options?.branch) params.branch = options.branch;
    if (options?.search) params.search = options.search;
    if (options?.techRevs !== undefined) params.techRevs = options.techRevs;
    if (options?.page !== undefined) params.page = options.page;
    if (options?.size !== undefined) params.size = options.size;

    const url = options?.branch
      ? `/repos/${encodeURIComponent(repository)}/branches/${encodeURIComponent(options.branch)}/projects/${encodeURIComponent(projectName)}/history`
      : `/repos/${encodeURIComponent(repository)}/projects/${encodeURIComponent(projectName)}/history`;

    const response = await this.axiosInstance.get<Types.PageResponse<Types.ProjectRevision>>(
      url,
      { params }
    );
    return response.data;
  }

  // =============================================================================
  // Project Management
  // =============================================================================

  /**
   * Build URL-safe project path for OpenL API
   *
   * projectId is treated as an opaque backend identifier.
   *
   * @param projectId - Project ID returned by backend
   * @returns URL-encoded project path
   */
  private buildProjectPath(projectId: string): string {
    // Normalize the projectId to avoid issues with surrounding whitespace
    // and double-encoding of already-percent-encoded values.
    const trimmed = projectId.trim();

    let normalizedId = trimmed;

    // If the ID appears to contain percent-encoded sequences, attempt to decode
    // it first to avoid double-encoding (e.g., %20 -> %2520).
    if (/%[0-9A-Fa-f]{2}/.test(trimmed)) {
      try {
        normalizedId = decodeURIComponent(trimmed);
      } catch {
        // If decoding fails (malformed encoding), fall back to the trimmed value.
        normalizedId = trimmed;
      }
    }

    return `/projects/${encodeURIComponent(normalizedId)}`;
  }

  /**
   * List all projects with optional filters and pagination
   *
   * @param filters - Optional filters for repository, status, tags, and pagination
   * @returns Array of project summaries (for backward compatibility, extracts content from PageResponse)
   */
  async listProjects(
      filters?: Types.ProjectFilters
  ): Promise<Types.ProjectSummary[]> {
    // Build query parameters, handling tags with 'tags.' prefix and pagination
    const params: Record<string, string | number> = {};
    if (filters?.repository) params.repository = filters.repository;
    if (filters?.status) params.status = filters.status;
    if (filters?.tags) {
      // Tags must be prefixed with 'tags.' in query string
      Object.entries(filters.tags).forEach(([key, value]) => {
        params[`tags.${key}`] = value;
      });
    }

    // Handle pagination parameters
    // Support both page/size (OpenL API format) and offset/limit (alternative format)
    if (filters?.page !== undefined) {
      params.page = filters.page;
    } else if (filters?.offset !== undefined && filters?.limit !== undefined) {
      // Convert offset/limit to page/size
      params.page = Math.floor(filters.offset / filters.limit);
    }

    if (filters?.size !== undefined) {
      params.size = filters.size;
    } else if (filters?.limit !== undefined) {
      params.size = filters.limit;
    }

    const response = await this.axiosInstance.get<Types.PageResponse<Types.ProjectSummary> | Types.ProjectSummary[] | { content?: Types.ProjectSummary[]; data?: Types.ProjectSummary[] }>(
        "/projects",
        { params }
    );

    // Handle different response formats:
    // 1. PageResponse: { content: [...], pageNumber: 0, pageSize: 50, total: 100 }
    // 2. Direct array: [...] (backward compatibility)
    // 3. Wrapped response: { data: [...] } (legacy format)
    const responseData = response.data;
    if (Array.isArray(responseData)) {
      // Direct array format (backward compatibility)
      return responseData;
    } else if (responseData && typeof responseData === 'object') {
      if ('content' in responseData && Array.isArray(responseData.content)) {
        // PageResponse format: extract content array
        return responseData.content;
      } else if ('data' in responseData && Array.isArray(responseData.data)) {
        // Legacy wrapped format
        return responseData.data;
      }
    }

    // Fallback: return empty array if format is unexpected
    return [];
  }

  /**
   * Get project details by ID
   *
   * @param projectId - Opaque project ID returned by backend.
   * @returns Project details
   */
  async getProject(projectId: string): Promise<Types.ComprehensiveProject> {
    const projectPath = this.buildProjectPath(projectId);
    const response = await this.axiosInstance.get<Types.Project>(projectPath);
    return response.data as Types.ComprehensiveProject;
  }

  /**
   * Throws if the project is in a local repository (repository === "local").
   * Local repositories are not connected to a remote Git; status change (open/save/close) is not supported by the API.
   */
  private async ensureNotLocalRepository(projectId: string): Promise<void> {
    const project = await this.getProject(projectId);
    if (project.repository === REPOSITORY_LOCAL) {
      throw new Error(ERROR_LOCAL_REPOSITORY);
    }
  }

  /**
   * Fetches the project and throws if it is in a local repository.
   * Use when you need the project data and the "not local" check in one GET.
   */
  private async getProjectAndEnsureNotLocal(projectId: string): Promise<Types.ComprehensiveProject> {
    const project = await this.getProject(projectId);
    if (project.repository === REPOSITORY_LOCAL) {
      throw new Error(ERROR_LOCAL_REPOSITORY);
    }
    return project;
  }

  /**
   * Delete a project
   *
   * @param projectId - Opaque project ID returned by backend.
   * @returns void (204 No Content on success)
   */
  async deleteProject(projectId: string): Promise<void> {
    const projectPath = this.buildProjectPath(projectId);
    await this.axiosInstance.delete(projectPath);
    // Returns 204 No Content
  }

  /**
   * Open a project for viewing/editing.
   *
   * Sends PATCH /projects/{projectId} with status "OPENED".
   * Use this only for projects that are not yet opened (status CLOSED, etc.).
   * For switching branches on an already opened project, use {@link switchBranch} instead
   * to avoid a 409 Conflict error.
   *
   * @param projectId - Opaque project ID returned by backend.
   * @param options - Optional branch, revision, and comment
   * @returns Success status (204 No Content on success)
   */
  async openProject(
    projectId: string,
    options?: { branch?: string; revision?: string; comment?: string }
  ): Promise<boolean> {
    await this.ensureNotLocalRepository(projectId);
    const projectPath = this.buildProjectPath(projectId);

    const updateModel: Types.ProjectStatusUpdateModel = {
      status: "OPENED",
      ...options,
    };

    await this.axiosInstance.patch(projectPath, updateModel);
    return true;
  }

  /**
   * Switch branch on an already opened project.
   *
   * Sends PATCH /projects/{projectId} with only the branch field (no status).
   * This avoids the 409 Conflict error that occurs when sending status "OPENED"
   * for a project that is already opened or being edited.
   *
   * The OpenL Studio backend validator (canOpen) rejects re-opening an already
   * opened project. However, a PATCH with just {"branch": "..."} is accepted
   * and returns 204.
   *
   * @param projectId - Opaque project ID returned by backend.
   * @param branch - Target branch name to switch to
   * @returns Success status (204 No Content on success)
   */
  async switchBranch(
    projectId: string,
    branch: string
  ): Promise<boolean> {
    await this.ensureNotLocalRepository(projectId);
    const projectPath = this.buildProjectPath(projectId);

    const switchModel: Types.ProjectStatusUpdateModel = {
      branch,
    };

    await this.axiosInstance.patch(projectPath, switchModel);
    return true;
  }

  /**
   * Close an open project
   *
   * Updates project status to CLOSED using PATCH /projects/{projectId}
   *
   * @param projectId - Opaque project ID returned by backend.
   * @param comment - Optional comment describing why the project is being closed
   * @returns Success status (204 No Content on success)
   */
  async closeProject(projectId: string, comment?: string): Promise<boolean> {
    await this.ensureNotLocalRepository(projectId);
    const projectPath = this.buildProjectPath(projectId);
    const updateModel: Types.ProjectStatusUpdateModel = {
      status: "CLOSED",
      comment,
    };

    await this.axiosInstance.patch(projectPath, updateModel);
    return true;
  }

  /**
   * Update project status with safety checks for unsaved changes
   *
   * Only OPENED and CLOSED can be set; other statuses (LOCAL, ARCHIVED, VIEWING_VERSION, EDITING) are set automatically by the backend.
   * Prevents accidental data loss by requiring explicit confirmation when closing projects with unsaved changes.
   *
   * @param projectId - Opaque project ID returned by backend.
   * @param request - Status update request; status may be OPENED or CLOSED only
   * @returns Success status (204 No Content on success)
   * @throws Error if trying to close EDITING project without save or explicit discard
   */
  async updateProjectStatus(
    projectId: string,
    request: {
      status?: "OPENED" | "CLOSED";
      comment?: string;
      discardChanges?: boolean;
      branch?: string;
      revision?: string;
    }
  ): Promise<{ success: boolean; message: string }> {
    const projectPath = this.buildProjectPath(projectId);

    // SAFETY CHECK: Prevent closing with unsaved changes without explicit confirmation
    if (request.status === "CLOSED") {
      const currentProject = await this.getProjectAndEnsureNotLocal(projectId);
      if (currentProject.status === "EDITING") {
        // Project has unsaved changes
        if (!request.comment && !request.discardChanges) {
          throw new Error(
            "Cannot close project with unsaved changes. " +
            "Options:\n" +
            "1. Provide 'comment' to save changes before closing: {status: 'CLOSED', comment: 'your message'}\n" +
            "2. Set 'discardChanges: true' to explicitly discard unsaved changes: {status: 'CLOSED', discardChanges: true}"
          );
        }
      }
    } else {
      await this.ensureNotLocalRepository(projectId);
    }

    // Build the API request (discardChanges is MCP-only, not sent to API)
    const updateModel: Types.ProjectStatusUpdateModel = {
      status: request.status,
      comment: request.comment,
      branch: request.branch,
      revision: request.revision,
    };

    // Call the OpenL Studio API
    await this.axiosInstance.patch(projectPath, updateModel);

    // Build success message based on what happened
    let message = "Project status updated successfully";
    if (request.status === "CLOSED" && request.comment) {
      message = "Project saved and closed successfully";
    } else if (request.status === "CLOSED" && request.discardChanges) {
      message = "Project closed (changes discarded)";
    } else if (request.status === "OPENED") {
      message = "Project opened successfully";
    } else if (request.comment && !request.status) {
      message = "Project changes saved successfully";
    }

    return { success: true, message };
  }

  /**
   * Save project changes, creating a new revision in the repository
   *
   * Works only when project status is EDITING. Requires comment; the server creates a new
   * revision with that comment and transitions the project to OPENED (or CLOSED if closeAfterSave).
   * Uses PATCH /projects/{projectId} with body { comment } or { comment, status: "CLOSED" }.
   *
   * This method validates the project before saving (if validation endpoint is available).
   *
   * @param projectId - Opaque project ID returned by backend.
   * @param comment - Comment for the new revision (required when project is EDITING; used as commit message)
   * @param options - Optional. closeAfterSave: if true, send status CLOSED so project is saved and closed in one request.
   * @returns Save result; if project is not EDITING, returns success with message "nothing to save" (no API call).
   * @throws Error if comment is missing or empty when project is EDITING
   */
  async saveProject(
    projectId: string,
    comment: string,
    options?: { closeAfterSave?: boolean }
  ): Promise<Types.SaveProjectResult> {
    const project = await this.getProjectAndEnsureNotLocal(projectId);
    if (project.status !== "EDITING") {
      return {
        success: true,
        message: "There are no changes in the project; nothing to save.",
      };
    }
    if (!comment.trim()) {
      throw new Error("comment is required for save; it is used as the revision (commit) message.");
    }

    const projectPath = this.buildProjectPath(projectId);

    // First validate the project (if validation endpoint is available)
    try {
      const validation = await this.validateProject(projectId);

      // If there are errors, return them without saving
      if (!validation.valid) {
        return {
          success: false,
          message: `Project has ${validation.errors.length} validation error(s). Fix errors before saving.`,
          validationErrors: validation.errors,
        };
      }
    } catch (error: any) {
      // If validation endpoint returns 404 (not available), proceed with save
      // Other errors are rethrown
      if (error.response && error.response.status === 404) {
        // Validation unavailable - proceed as if validation passed
      } else {
        throw error;
      }
    }

    // Save via PATCH /projects/{projectId} (Update project status API).
    // When project is EDITING and comment is present, the server creates a new revision and sets status to OPENED (or CLOSED if requested).
    const body: { comment: string; status?: "CLOSED" } = { comment: comment.trim() };
    if (options?.closeAfterSave) {
      body.status = "CLOSED";
    }
    await this.axiosInstance.patch(projectPath, body);

    const message = comment.trim();

    return {
      success: true,
      message,
    };
  }

  // =============================================================================
  // File Management
  // =============================================================================

  /**
   * Upload an Excel file with rules to a project
   *
   * @param projectId - Opaque project ID returned by backend.
   * @param fileName - Name of the file to upload
   * @param fileContent - File content as Buffer or string
   * @param comment - Optional comment
   * @returns Upload result
   */
  async uploadFile(
    projectId: string,
    fileName: string,
    fileContent: Buffer | string,
    comment?: string
  ): Promise<Types.FileUploadResult> {
    const projectPath = this.buildProjectPath(projectId);

    // Validate file extension
    if (!fileName.match(/\.(xlsx|xls)$/i)) {
      return {
        success: false,
        fileName,
        message: "Only Excel files (.xlsx, .xls) are supported",
      };
    }

    // Convert to Buffer if string
    const buffer = Buffer.isBuffer(fileContent) ? fileContent : Buffer.from(fileContent);

    try {
      // Upload file using axios with buffer
      // IMPORTANT: Use the fileName exactly as provided - can be simple name, subdirectory path, or full path
      // e.g., "Rules.xlsx", "rules/Premium.xlsx", or "Example 1 - Bank Rating/Bank Rating.xlsx"
      // Encode each path segment separately to preserve directory structure (like downloadFile)
      const encodedFileName = fileName.split('/').map(encodeURIComponent).join('/');
      const response = await this.axiosInstance.post(
        `${projectPath}/files/${encodedFileName}`,
        buffer,
        {
          headers: {
            "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
          },
          params: comment ? { comment } : undefined,
        }
      );

      // Extract file metadata from response (FileData structure)
      // Note: The file is uploaded to workspace but NOT committed to Git yet
      const fileData = response.data || {};
      const version = fileData.version || fileData.commitHash;

      return {
        success: true,
        fileName,
        commitHash: version,  // Not actually a commit hash yet - file is in workspace
        version,
        author: fileData.author ? {
          name: fileData.author.name || "unknown",
          email: fileData.author.email || ""
        } : undefined,
        timestamp: fileData.modifiedAt || new Date().toISOString(),
        size: fileData.size || buffer.length,
        message: `File uploaded successfully to workspace. Use openl_save_project to save changes to Git.`,
      };
    } catch (error: any) {
      // Provide helpful error messages for common upload failures
      if (error.response && error.response.status === 404) {
        throw new Error(
          `Upload failed: Invalid path "${fileName}" in project "${projectId}". ` +
          `Ensure the project is open and the file path is valid. ` +
          `Valid formats: simple name ('Rules.xlsx'), subdirectory ('rules/Premium.xlsx'), or full path ('Example 1 - Bank Rating/Bank Rating.xlsx'). ` +
          `To verify project exists and is open, use: openl_get_project(projectId: "${projectId}")`
        );
      }
      if (error.response && error.response.status === 409) {
        throw new Error(
          `Upload failed: Conflict detected for "${fileName}". ` +
          `The file may be locked by another user or there may be uncommitted changes. ` +
          `Try opening the project first or resolving any conflicts.`
        );
      }
      // Re-throw other errors with additional context
      throw new Error(`Upload failed for "${fileName}": ${error.message}`);
    }
  }

  /**
   * Download an Excel file from a project
   *
   * @param projectId - Opaque project ID returned by backend.
   * @param fileName - Name of the file to download (use the exact 'file' value from list_tables response)
   * @param version - Optional Git commit hash to download specific version
   * @returns File content as Buffer
   * @throws Error with helpful message if file not found (404)
   */
  async downloadFile(projectId: string, fileName: string, version?: string): Promise<Buffer> {
    const projectPath = this.buildProjectPath(projectId);

    // Build request params
    const params: any = {};
    if (version) {
      params.version = version;  // Git commit hash
    }

    // IMPORTANT: list_tables returns file paths like "Example 2 - Corporate Rating/Corporate Rating.xlsx"
    // The OpenL API expects the full path AS-IS from list_tables, including the project directory.
    // We'll try multiple variations to handle different scenarios.

    const pathsToTry: string[] = [];

    // Try the fileName exactly as provided first
    pathsToTry.push(fileName);

    // Keep a fallback without leading project directory for APIs that normalize paths.
    if (fileName.includes("/")) {
      const withoutProjectDir = fileName.substring(fileName.indexOf("/") + 1);
      if (withoutProjectDir && withoutProjectDir !== fileName) {
        pathsToTry.push(withoutProjectDir);
      }
    }

    let lastError: any;

    // Try each path until one works
    for (const pathToTry of pathsToTry) {
      try {
        // Encode each path segment separately to preserve directory structure
        // Don't encode forward slashes within the path
        const encodedPath = pathToTry.split('/').map(encodeURIComponent).join('/');

        const response = await this.axiosInstance.get<ArrayBuffer>(
          `${projectPath}/files/${encodedPath}`,
          {
            responseType: "arraybuffer",
            params,
          }
        );

        return Buffer.from(response.data);
      } catch (error: any) {
        lastError = error;
        // If not a 404, don't try other paths
        if (error.response && error.response.status !== 404) {
          break;
        }
        // Continue to next path on 404
      }
    }

    // All paths failed, provide helpful error message
    if (lastError && lastError.response && lastError.response.status === 404) {
      throw new Error(
        `File not found: "${fileName}". ` +
        `Tried paths: ${pathsToTry.map(p => `"${p}"`).join(", ")}. ` +
        `The file does not exist in project "${projectId}". ` +
        `To find available files: 1) Call list_tables(projectId="${projectId}") to see all tables and their file paths, ` +
        `2) Use the exact 'file' field value from a table entry as the fileName parameter. ` +
        `Common causes: File path typo, wrong project, or file was deleted.`
      );
    } else if (lastError && lastError.response && lastError.response.status === 400) {
      throw new Error(
        `Invalid file path: "${fileName}". ` +
        `The OpenL API rejected this file path (400 Bad Request). ` +
        `You must use the exact 'file' field value from list_tables() response, including any directory prefix. ` +
        `For example, if list_tables shows "Example 2 - Corporate Rating/Corporate Rating.xlsx", use that full path. ` +
        `Original error: ${lastError.message}`
      );
    }

    // Re-throw other errors
    throw lastError;
  }

  /**
   * Create a new branch in a project
   *
   * @param projectId - Opaque project ID returned by backend.
   * @param branchName - Name for the new branch
   * @param revision - Optional Git revision to branch from
   * @returns Success status
   */
  async createBranch(
    projectId: string,
    branchName: string,
    revision?: string
  ): Promise<boolean> {
    const projectPath = this.buildProjectPath(projectId);
    const request: Types.BranchCreateRequest = {
      branch: branchName,
      revision,
    };
    await this.axiosInstance.post(
      `${projectPath}/branches`,
      request
    );
    return true;
  }

  // =============================================================================
  // Rules (Tables) Management
  // =============================================================================

  /**
   * List all tables/rules in a project with optional filters and pagination
   *
   * @param projectId - Opaque project ID returned by backend.
   * @param filters - Optional filters for table type, name, properties, and pagination
   * @returns Array of table metadata (for backward compatibility, extracts content from PageResponse)
   */
  async listTables(
      projectId: string,
      filters?: Types.TableFilters
  ): Promise<Types.TableMetadata[]> {
    const projectPath = this.buildProjectPath(projectId);

    // Build query parameters, handling kind (array), properties with 'properties.' prefix, and pagination
    const params: Record<string, string | string[] | number> = {};
    if (filters?.kind && filters.kind.length > 0) {
      // API expects 'kind' as array parameter
      params.kind = filters.kind;
    }
    if (filters?.name) params.name = filters.name;
    if (filters?.properties) {
      // Properties must be prefixed with 'properties.' in query string
      Object.entries(filters.properties).forEach(([key, value]) => {
        params[`properties.${key}`] = value;
      });
    }

    // Handle pagination parameters
    // Support both page/size (OpenL API format) and offset/limit (alternative format)
    if (filters?.page !== undefined) {
      params.page = filters.page;
    } else if (filters?.offset !== undefined && filters?.limit !== undefined) {
      // Convert offset/limit to page/size
      params.page = Math.floor(filters.offset / filters.limit);
    }

    if (filters?.size !== undefined) {
      params.size = filters.size;
    } else if (filters?.limit !== undefined) {
      params.size = filters.limit;
    }

    const response = await this.axiosInstance.get<Types.PageResponse<Types.TableMetadata> | Types.TableMetadata[]>(
        `${projectPath}/tables`,
        { params }
    );

    // Handle different response formats:
    // 1. Direct array: [...] (backward compatibility)
    // 2. Legacy wrapper: { data: [...] }
    // 3. PageResponse: { content: [...], pageNumber: 0, pageSize: 50, total: 100 }
    // 4. Legacy wrapped PageResponse: { data: { content: [...] } }
    const responseData = response.data;
    if (Array.isArray(responseData)) {
      // Direct array format (backward compatibility)
      return responseData;
    } else if (responseData && typeof responseData === 'object') {
      // Check for legacy wrapper: { data: [...] }
      if ('data' in responseData && Array.isArray(responseData.data)) {
        return responseData.data;
      }
      // Check for legacy wrapped PageResponse: { data: { content: [...] } }
      if ('data' in responseData && responseData.data && typeof responseData.data === 'object' && 'content' in responseData.data && Array.isArray(responseData.data.content)) {
        return responseData.data.content;
      }
      // Check for PageResponse format: { content: [...] }
      if ('content' in responseData && Array.isArray(responseData.content)) {
        return responseData.content;
      }
    }

    // Fallback: return empty array if format is unexpected
    return [];
  }

  /**
   * Create a new rule/table in a project
   *
   * @param projectId - Opaque project ID returned by backend.
   * @param request - Rule creation request with name, type, and properties
   * @returns Creation result with table ID
   */
  async createRule(
    projectId: string,
    request: Types.CreateRuleRequest
  ): Promise<Types.CreateRuleResult> {
    const projectPath = this.buildProjectPath(projectId);

    try {
      // Build table signature if parameters provided
      let signature = request.name;
      if (request.returnType && request.parameters) {
        const params = request.parameters.map(p => `${p.type} ${p.name}`).join(", ");
        signature = `${request.returnType} ${request.name}(${params})`;
      }

      const response = await this.axiosInstance.post(
        `${projectPath}/tables`,
        {
          name: request.name,
          type: request.tableType,
          signature,
          returnType: request.returnType,
          parameters: request.parameters,
          properties: request.properties,
          file: request.file,
          comment: request.comment,
        }
      );

      return {
        success: true,
        tableId: response.data.id || `${request.name}-${request.tableType}`,
        tableName: request.name,
        tableType: request.tableType,
        file: response.data.file || request.file,
        message: `Created ${request.tableType} table '${request.name}' successfully`,
      };
    } catch (error: unknown) {
      const errorMsg = sanitizeError(error);

      // Newer OpenL versions use CreateNewTableRequest payload for POST /projects/{projectId}/tables
      // and can reject legacy createRule payload with 400/405.
      if (errorMsg.includes("400") || errorMsg.includes("405")) {
        return {
          success: false,
          message: `Table creation requires the 'Create New Project Table' contract ` +
            `(moduleName, optional sheetName, and full EditableTableView payload). ` +
            `Use openl_create_project_table instead of createRule-style payload.`,
        };
      }

      return {
        success: false,
        message: `Failed to create ${request.tableType} table '${request.name}': ${errorMsg}`,
      };
    }
  }

  /**
   * Create a new table in a project using BETA API
   *
   * @param projectId - Opaque project ID returned by backend.
   * @param request - Table creation request with moduleName, sheetName, and complete table structure
   * @returns Created table summary with table ID
   */
  async createProjectTable(
    projectId: string,
    request: Types.CreateNewTableRequest
  ): Promise<Types.TableMetadata> {
    const projectPath = this.buildProjectPath(projectId);

    const response = await this.axiosInstance.post<Types.TableMetadata>(
      `${projectPath}/tables`,
      {
        moduleName: request.moduleName,
        sheetName: request.sheetName,
        table: request.table,
      }
    );

    return response.data;
  }

  /**
   * Get detailed table data and structure
   *
   * @param projectId - Opaque project ID returned by backend.
   * @param tableId - Table identifier
   * @returns Complete table view with data and structure
   */
  async getTable(projectId: string, tableId: string): Promise<Types.TableView> {
    const projectPath = this.buildProjectPath(projectId);
    const response = await this.axiosInstance.get<Types.TableView>(
      `${projectPath}/tables/${encodeURIComponent(tableId)}`
    );
    return response.data;
  }

  /**
   * Update table content
   *
   * @param projectId - Opaque project ID returned by backend.
   * @param tableId - Table identifier
   * @param view - Updated table view with modifications (MUST include full table structure from get_table)
   * @param comment - Optional comment describing the changes (NOTE: not supported by OpenAPI schema, will be ignored)
   * @returns void (204 No Content on success)
   * @throws Error if view is missing required fields
   */
  async updateTable(
    projectId: string,
    tableId: string,
    view: Types.EditableTableView
  ): Promise<void> {
    // Validate that view contains required fields
    // OpenL API requires the FULL table structure, not just modified fields
    const requiredFields = ['id', 'tableType', 'kind', 'name'];
    const missingFields = requiredFields.filter(field => !(field in view));

    if (missingFields.length > 0) {
      throw new Error(
        `Invalid table view: missing required fields: ${missingFields.join(', ')}. ` +
        `The view parameter must contain the FULL table structure from get_table(), not just the modified fields. ` +
        `Workflow: 1) Call get_table() to retrieve current structure, 2) Modify the returned object, 3) Pass the complete object to update_table().`
      );
    }

    // Validate tableId matches view.id
    if (view.id !== tableId) {
      throw new Error(
        `Table ID mismatch: tableId parameter is "${tableId}" but view.id is "${view.id}". ` +
        `These must match. Use the same ID from get_table() for both parameters.`
      );
    }

    const projectPath = this.buildProjectPath(projectId);
    // OpenAPI schema expects EditableTableView directly as request body
    await this.axiosInstance.put(
      `${projectPath}/tables/${encodeURIComponent(tableId)}`,
      view
    );
    // Returns 204 No Content
  }

  /**
   * Append lines to a project table
   *
   * @param projectId - Opaque project ID returned by backend.
   * @param tableId - Table identifier
   * @param appendData - Data to append with fields and table type
   * @returns void (200 OK on success per schema)
   */
  async appendProjectTable(
    projectId: string,
    tableId: string,
    appendData: Types.AppendTableView
  ): Promise<void> {
    const projectPath = this.buildProjectPath(projectId);
    await this.axiosInstance.post(
      `${projectPath}/tables/${encodeURIComponent(tableId)}/lines`,
      appendData
    );
  }

  // =============================================================================
  // Deployment Management
  // =============================================================================

  /**
   * List all deployments with optional repository filter
   *
   * @param repository - Optional repository ID to filter deployments
   * @returns Array of deployment information
   */
  async listDeployments(repository?: string): Promise<Types.DeploymentViewModel_Short[]> {
    const response = await this.axiosInstance.get<Types.DeploymentViewModel_Short[]>(
      "/deployments",
      { params: repository ? { repository } : undefined }
    );
    return response.data;
  }

  /**
   * Deploy a project to production repository
   *
   * @param request - Deployment request with project ID, deployment name, and target repository
   * @returns Success status (204 No Content on success)
   */
  async deployProject(request: Types.DeployProjectRequest): Promise<void> {
    await this.axiosInstance.post(
      "/deployments",
      {
        projectId: request.projectId,
        deploymentName: request.deploymentName,
        productionRepositoryId: request.productionRepositoryId,
        comment: request.comment,
      }
    );
  }

  /**
   * Redeploy an existing deployment
   *
   * @param deploymentId - Deployment ID to redeploy
   * @param request - Redeploy request with project ID and optional comment
   * @returns Success status (204 No Content on success)
   */
  async redeployProject(
    deploymentId: string,
    request: Types.RedeployProjectRequest
  ): Promise<void> {
    await this.axiosInstance.post(
      `/deployments/${encodeURIComponent(deploymentId)}`,
      {
        projectId: request.projectId,
        comment: request.comment,
      }
    );
  }

  /**
   * Get project local changes (workspace history)
   *
   * @returns List of local change history items
   * @note This endpoint requires the project to be loaded in OpenL Studio session.
   *       The endpoint `/history/project` uses session-based project context.
   */
  async getProjectLocalChanges(): Promise<Types.ProjectHistoryItem[]> {
    // Note: This endpoint requires the project to be loaded in OpenL Studio session
    // The endpoint is /history/project and uses session-based project context
    const response = await this.axiosInstance.get<Types.ProjectHistoryItem[]>(
      "/history/project"
    );
    return response.data;
  }

  /**
   * Restore project to a local change version
   *
   * @param historyId - History ID to restore
   * @returns Success status (204 No Content on success)
   * @note This endpoint requires the project to be loaded in OpenL Studio session.
   *       The endpoint `/history/restore` uses session-based project context.
   */
  async restoreProjectLocalChange(historyId: string): Promise<void> {
    // Note: This endpoint requires the project to be loaded in OpenL Studio session
    // The endpoint is /history/restore and uses session-based project context
    await this.axiosInstance.post(
      "/history/restore",
      historyId,
      {
        headers: {
          "Content-Type": "text/plain",
        },
      }
    );
  }

  // =============================================================================
  // Test Execution Session Management
  // =============================================================================

  /**
   * Store test execution headers for a project.
   * Always keyed by projectId only — a project can have only one active test session.
   * 
   * @param projectId - Project ID
   * @param headers - Headers from test start response
   */
  private storeTestExecutionHeaders(
    projectId: string,
    headers: Record<string, string>
  ): void {
    this.testExecutionHeaders.set(projectId, headers);
  }

  /**
   * Get test execution headers for a project
   * 
   * @param projectId - Project ID
   * @returns Headers if found, undefined otherwise
   */
  private getTestExecutionHeaders(
    projectId: string
  ): Record<string, string> | undefined {
    return this.testExecutionHeaders.get(projectId);
  }

  /**
   * Clear test execution headers for a project
   * 
   * @param projectId - Project ID
   */
  private clearTestExecutionHeaders(projectId: string): void {
    this.testExecutionHeaders.delete(projectId);
  }

  /**
   * Extract headers from test start response
   * 
   * @param headers - Response headers from axios
   * @returns Extracted headers ready for use in subsequent requests
   */
  private extractTestExecutionHeaders(headers: Record<string, unknown>): Record<string, string> {
    const responseHeaders: Record<string, string> = {};
    const excludeHeaders = [
      'content-type',
      'content-length',
      'content-encoding',
      'transfer-encoding',
      'connection',
      'server',
      'date',
      'etag',
      'last-modified',
      'cache-control',
      'expires',
      'vary',
      'access-control-allow-origin',
      'access-control-allow-methods',
      'access-control-allow-headers',
      'access-control-expose-headers',
      'accept',
    ];

    const setCookieValues: string[] = [];

    Object.keys(headers).forEach((key) => {
      const lowerKey = key.toLowerCase();

      if (lowerKey === 'set-cookie') {
        const value = headers[key];
        if (value !== undefined && value !== null) {
          const cookies = Array.isArray(value) ? value : [String(value)];
          cookies.forEach((cookie) => {
            const nameValue = cookie.split(';')[0].trim();
            if (nameValue) {
              setCookieValues.push(nameValue);
            }
          });
        }
      } else if (!excludeHeaders.includes(lowerKey)) {
        const value = headers[key];
        if (value !== undefined && value !== null) {
          responseHeaders[key] = Array.isArray(value) ? value.join(", ") : String(value);
        }
      }
    });

    if (setCookieValues.length > 0) {
      responseHeaders['Cookie'] = setCookieValues.join('; ');
    }

    return responseHeaders;
  }

  // =============================================================================
  // New Test Execution Methods
  // =============================================================================

  /**
   * Start project tests execution
   *
   * For design repositories: ensures project is opened before starting tests; automatically opens if closed.
   * For repository 'local': does not open the project; runs tests directly (local projects are always editable).
   *
   * @param projectId - Project ID
   * @param options - Test execution options
   * @returns Test execution start response
   * @throws Error if test execution fails
   */
  async startProjectTests(
    projectId: string,
    options?: {
      tableId?: string;
      testRanges?: string;
      fromModule?: string; // Reserved for future use - not currently used
    }
  ): Promise<Types.TestExecutionStartResponse> {
    const projectPath = this.buildProjectPath(projectId);

    // Local projects are always editable — skip open; for design repos open if needed
    let projectWasOpened = false;
    let needsOpen = false;
    try {
      const project = await this.getProject(projectId);
      needsOpen = project.repository !== REPOSITORY_LOCAL &&
                  project.status !== "OPENED" && project.status !== "EDITING";
    } catch {
      // getProject failed — attempt open anyway (will throw for local with a clear message)
      needsOpen = true;
    }
    if (needsOpen) {
      try {
        await this.openProject(projectId);
        projectWasOpened = true;
      } catch (openError) {
        throw new Error(`Failed to open project: ${sanitizeError(openError)}.`);
      }
    }

    // Clear old headers for this project before storing new ones
    this.clearTestExecutionHeaders(projectId);

    // Build API parameters
    const params: Record<string, string | number | boolean> = {};
    if (options?.tableId) params.tableId = options.tableId;
    if (options?.testRanges) params.testRanges = options.testRanges;
    // fromModule is reserved for future use - not currently passed to API

    // Start test execution
    const startResponse = await this.axiosInstance.post(
      `${projectPath}/tests/run`,
      undefined,
      { params }
    );

    // Extract and store headers
    const responseHeaders = this.extractTestExecutionHeaders(startResponse.headers || {});
    this.storeTestExecutionHeaders(projectId, responseHeaders);

    return {
      status: "started",
      projectId,
      tableId: options?.tableId,
      testRanges: options?.testRanges,
      projectWasOpened,
      message: `Test execution started${projectWasOpened ? " (project was automatically opened)" : ""}`,
    };
  }

  /**
   * Get test results summary (without testCases array)
   * 
   * @param projectId - Project ID
   * @param options - Summary options
   * @returns Test results summary
   * @throws Error if headers not found or request fails
   */
  async getTestResultsSummary(
    projectId: string,
    options?: {
      failures?: number;
      unpaged?: boolean;
    }
  ): Promise<Types.TestResultsSummary> {
    const projectPath = this.buildProjectPath(projectId);
    const headers = this.getTestExecutionHeaders(projectId);

    if (!headers) {
      throw new Error(
        `No test execution session found for project '${projectId}'. ` +
        `Use openl_start_project_tests() to start test execution first.`
      );
    }

    const params: Record<string, string | number | boolean> = {};
    if (options?.failures !== undefined) params.failures = options.failures;
    if (options?.unpaged) params.unpaged = true;

    const response = await this.axiosInstance.get<Types.TestsExecutionSummary>(
      `${projectPath}/tests/summary`,
      {
        params,
        headers: {
          ...headers,
          "Accept": "application/json",
        },
      }
    );

    const summary = response.data;
    const numberOfPassed = summary.numberOfTests - summary.numberOfFailures;

    return {
      executionTimeMs: summary.executionTimeMs,
      numberOfTests: summary.numberOfTests,
      numberOfFailures: summary.numberOfFailures,
      numberOfPassed,
    };
  }

  /**
   * Get full test results with pagination
   * 
   * @param projectId - Project ID
   * @param options - Result options including pagination
   * @returns Full test execution summary with testCases
   * @throws Error if headers not found or request fails
   */
  async getTestResults(
    projectId: string,
    options?: {
      failuresOnly?: boolean;
      failures?: number;
      page?: number;
      offset?: number;
      size?: number;
      limit?: number; // Alias for size
      unpaged?: boolean;
    }
  ): Promise<Types.TestsExecutionSummary> {
    const projectPath = this.buildProjectPath(projectId);
    const headers = this.getTestExecutionHeaders(projectId);

    if (!headers) {
      throw new Error(
        `No test execution session found for project '${projectId}'. ` +
        `Use openl_start_project_tests() to start test execution first.`
      );
    }

    const params: Record<string, string | number | boolean> = {};
    if (options?.failuresOnly) params.failuresOnly = true;
    if (options?.failures !== undefined) params.failures = options.failures;
    if (options?.page !== undefined) params.page = options.page;
    if (options?.offset !== undefined) params.offset = options.offset;
    if (options?.size !== undefined) params.size = options.size;
    else if (options?.limit !== undefined) params.size = options.limit; // Map limit to size
    if (options?.unpaged) params.unpaged = true;

    const response = await this.axiosInstance.get<Types.TestsExecutionSummary>(
      `${projectPath}/tests/summary`,
      {
        params,
        headers: {
          ...headers,
          "Accept": "application/json",
        },
      }
    );

    return response.data;
  }

  /**
   * Get test results filtered by table ID
   * 
   * @param projectId - Project ID
   * @param tableId - Table ID to filter results
   * @param options - Result options
   * @returns Filtered test execution summary
   * @throws Error if headers not found or request fails
   */
  async getTestResultsByTable(
    projectId: string,
    tableId: string,
    options?: {
      failuresOnly?: boolean;
      failures?: number;
      page?: number;
      offset?: number;
      size?: number;
      limit?: number;
      unpaged?: boolean;
    }
  ): Promise<Types.TestsExecutionSummary> {
    if (options?.unpaged) {
      const unpagedResults = await this.getTestResults(projectId, {
        failuresOnly: options.failuresOnly,
        failures: options.failures,
        unpaged: true,
      });
      const filteredTestCases = (unpagedResults.testCases || []).filter(
        (testCase) => testCase.tableId === tableId
      );
      const numberOfTests = filteredTestCases.reduce(
        (sum, tc) => sum + tc.numberOfTests,
        0
      );
      const numberOfFailures = filteredTestCases.reduce(
        (sum, tc) => sum + tc.numberOfFailures,
        0
      );

      return {
        ...unpagedResults,
        testCases: filteredTestCases,
        numberOfTests,
        numberOfFailures,
      };
    }

    // Collect all test results across pages, then filter by tableId.
    // Pagination options from the caller are applied AFTER filtering, to avoid
    // missing the requested table when it is not on the selected page.
    const baseOptions = {
      failuresOnly: options?.failuresOnly,
      failures: options?.failures,
      // Use caller's size/limit only as page size when iterating pages.
      size: options?.size,
      limit: options?.limit,
    };
    let pageIndex = 0;
    let templateSummary: Types.TestsExecutionSummary | null = null;
    const allMatchingTestCases: Types.TestCaseExecutionResult[] = [];

    // Iterate pages until no more test cases are returned.
    // We do not use caller's page/offset here to ensure we scan all tables.
    const pageSize = baseOptions.size ?? baseOptions.limit ?? 50;
    
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const pageResults = await this.getTestResults(projectId, {
        ...baseOptions,
        page: pageIndex,
      });
      if (!templateSummary) {
        templateSummary = pageResults;
      }
      
      // Stop if no test cases returned
      if (!pageResults.testCases || pageResults.testCases.length === 0) {
        break;
      }
      
      const pageMatches = pageResults.testCases.filter(
        (testCase) => testCase.tableId === tableId
      );
      allMatchingTestCases.push(...pageMatches);
      
      // Check if we've reached the end of pagination
      // Use totalPages if available, otherwise check if current page has fewer items than pageSize
      const hasMorePages = pageResults.totalPages !== undefined
        ? pageIndex < pageResults.totalPages - 1
        : (pageResults.numberOfElements !== undefined && pageResults.numberOfElements >= pageSize);
      
      if (!hasMorePages) {
        break;
      }
      
      pageIndex += 1;
      
      // Safety limit: prevent infinite loops (max 1000 pages)
      if (pageIndex >= 1000) {
        break;
      }
    }

    if (!templateSummary) {
      // No pages returned any results; construct an empty summary shape by
      // calling getTestResults once (without pagination options).
      templateSummary = await this.getTestResults(projectId, {
        failuresOnly: options?.failuresOnly,
        failures: options?.failures,
      });
    }

    // Apply caller's pagination options within the filtered test cases.
    let pagedTestCases = allMatchingTestCases;
    const hasPaginationOptions =
      options?.page !== undefined ||
      options?.offset !== undefined ||
      options?.size !== undefined ||
      options?.limit !== undefined;

    if (hasPaginationOptions && allMatchingTestCases.length > 0) {
      const pageSize = options?.size ?? options?.limit;
      let start = 0;
      if (options?.offset !== undefined) {
        start = options.offset;
      } else if (options?.page !== undefined && pageSize !== undefined) {
        start = options.page * pageSize;
      }
      const end = pageSize !== undefined ? start + pageSize : undefined;
      pagedTestCases = allMatchingTestCases.slice(start, end);
    }

    const numberOfTests = pagedTestCases.reduce(
      (sum, tc) => sum + tc.numberOfTests,
      0
    );
    const numberOfFailures = pagedTestCases.reduce(
      (sum, tc) => sum + tc.numberOfFailures,
      0
    );

    return {
      ...templateSummary,
      testCases: pagedTestCases,
      numberOfTests,
      numberOfFailures,
    };
  }

  // =============================================================================
  // Health Check
  // =============================================================================

  /**
   * Check server connectivity and authentication status
   *
   * @returns Health check result with server status and reachability
   */
  async healthCheck(): Promise<{
    status: string;
    baseUrl: string;
    authMethod: string;
    timestamp: string;
    serverReachable: boolean;
    error?: string;
  }> {
    const authMethod = this.getAuthMethod();

    try {
      // Try to list repositories as a connectivity check
      await this.listRepositories();

      return {
        status: "healthy",
        baseUrl: this.baseUrl,
        authMethod,
        timestamp: new Date().toISOString(),
        serverReachable: true,
      };
    } catch (error: unknown) {
      return {
        status: "unhealthy",
        baseUrl: this.baseUrl,
        authMethod,
        timestamp: new Date().toISOString(),
        serverReachable: false,
        error: sanitizeError(error),
      };
    }
  }

  // =============================================================================
  // Testing & Validation
  // =============================================================================
  // Note: runAllTests() and runTest() methods removed - endpoints don't exist in API
  // Use executeRule() to manually test individual rules instead

  /**
   * Validate a project for errors
   *
   * Note: The REST API does not expose a /validation endpoint.
   * This method will return a 404 error. Validation may occur
   * automatically when compiling or deploying projects.
   *
   * @param projectId - Opaque project ID returned by backend.
   * @returns Validation results with errors and warnings
   * @throws Error if endpoint doesn't exist (404)
   */
  async validateProject(projectId: string): Promise<Types.ValidationResult> {
    const projectPath = this.buildProjectPath(projectId);
    const response = await this.axiosInstance.get<Types.ValidationResult>(
      `${projectPath}/validation`
    );
    return response.data;
  }

  /**
   * Get detailed project errors with categorization and fix suggestions
   *
   * @param projectId - Opaque project ID returned by backend.
   * @param includeWarnings - Include warnings in result (default: true)
   * @returns Detailed validation result with error categorization
   */
  async getProjectErrors(
    projectId: string,
    includeWarnings: boolean = true
  ): Promise<Types.DetailedValidationResult> {
    // Get validation result (handle 404 as validation unavailable)
    let validation: Types.ValidationResult;
    try {
      validation = await this.validateProject(projectId);
    } catch (error: any) {
      // If validation endpoint returns 404 (not available), return empty result
      if (error.response && error.response.status === 404) {
        return {
          valid: true,
          errors: [],
          warnings: [],
          errorCount: 0,
          warningCount: 0,
          errorsByCategory: {
            typeErrors: [],
            syntaxErrors: [],
            referenceErrors: [],
            validationErrors: [],
          },
          autoFixableCount: 0,
        };
      }
      // Other errors are rethrown
      throw error;
    }

    // Categorize errors
    const typeErrors: Types.ValidationError[] = [];
    const syntaxErrors: Types.ValidationError[] = [];
    const referenceErrors: Types.ValidationError[] = [];
    const validationErrors: Types.ValidationError[] = [];

    validation.errors.forEach((error) => {
      const message = error.message.toLowerCase();
      if (message.includes("type") || message.includes("cannot convert")) {
        typeErrors.push(error);
      } else if (message.includes("syntax") || message.includes("unexpected")) {
        syntaxErrors.push(error);
      } else if (message.includes("not found") || message.includes("reference")) {
        referenceErrors.push(error);
      } else {
        validationErrors.push(error);
      }
    });

    // Count auto-fixable errors (type conversions, simple syntax)
    const autoFixableCount = typeErrors.length + syntaxErrors.filter(
      (e) => e.message.includes("bracket") || e.message.includes("parenthes")
    ).length;

    return {
      valid: validation.valid,
      errors: validation.errors,
      warnings: includeWarnings ? validation.warnings : [],
      errorCount: validation.errors.length,
      warningCount: validation.warnings.length,
      errorsByCategory: {
        typeErrors,
        syntaxErrors,
        referenceErrors,
        validationErrors,
      },
      autoFixableCount,
    };
  }

  // =============================================================================
  // Phase 3: Versioning & Execution
  // =============================================================================

  /**
   * Execute a rule with input data
   *
   * @param request - Execute rule request
   * @returns Execution result with output data
   */
  async executeRule(request: Types.ExecuteRuleRequest): Promise<Types.ExecuteRuleResult> {
    const projectPath = this.buildProjectPath(request.projectId);

    try {
      const startTime = Date.now();
      const response = await this.axiosInstance.post(
        `${projectPath}/rules/${encodeURIComponent(request.ruleName)}/execute`,
        request.inputData
      );
      const executionTime = Date.now() - startTime;

      return {
        success: true,
        output: response.data,
        executionTime,
      };
    } catch (error: unknown) {
      return {
        success: false,
        error: sanitizeError(error),
      };
    }
  }

  /**
   * Compare two versions of a project
   *
   * @param request - Compare versions request
   * @returns Comparison result with differences
   */
  async compareVersions(request: Types.CompareVersionsRequest): Promise<Types.CompareVersionsResult> {
    const projectPath = this.buildProjectPath(request.projectId);

    const response = await this.axiosInstance.get<Types.CompareVersionsResult>(
      `${projectPath}/versions/compare`,
      {
        params: {
          base: request.baseCommitHash,
          target: request.targetCommitHash,
        },
      }
    );

    return response.data;
  }

  // =============================================================================
  // Phase 4: Advanced Features
  // =============================================================================

  /**
   * Revert project to a previous version
   * Creates a new version with the content from the target version
   *
   * @param request - Revert version request
   * @returns Revert result with new version info
   */
  async revertVersion(request: Types.RevertVersionRequest): Promise<Types.RevertVersionResult> {
    const projectPath = this.buildProjectPath(request.projectId);

    try {
      // Step 1: Get the target version content
      await this.axiosInstance.get(
        `${projectPath}/versions/${encodeURIComponent(request.targetVersion)}`
      );

      // Step 2: Validate the project (if validation endpoint is available)
      try {
        const validation = await this.validateProject(request.projectId);

        if (!validation.valid) {
          return {
            success: false,
            message: `Project has validation errors. Fix them before reverting.`,
            validationErrors: validation.errors,
          };
        }
      } catch (error: any) {
        // If validation endpoint returns 404 (not available), proceed with revert
        // Other errors are rethrown
        if (error.response && error.response.status === 404) {
          // Validation unavailable - proceed as if validation passed
        } else {
          throw error;
        }
      }

      // Step 3: Create new version with old content (revert)
      const revertResponse = await this.axiosInstance.post(
        `${projectPath}/revert`,
        {
          targetVersion: request.targetVersion,
          comment: request.comment || `Revert to version ${request.targetVersion}`,
        }
      );

      return {
        success: true,
        newVersion: revertResponse.data.version,
        message: `Successfully reverted to version ${request.targetVersion}. New version: ${revertResponse.data.version}`,
      };
    } catch (error: unknown) {
      return {
        success: false,
        message: `Failed to revert: ${sanitizeError(error)}`,
      };
    }
  }

  // =============================================================================
  // Phase 2: Git Version History Methods
  // =============================================================================

  /**
   * Parse commit type from comment
   *
   * @param comment - Commit comment
   * @returns Commit type
   */
  private parseCommitType(comment?: string): Types.CommitType {
    if (!comment) return "SAVE";
    if (comment.includes("Type: ARCHIVE")) return "ARCHIVE";
    if (comment.includes("Type: RESTORE")) return "RESTORE";
    if (comment.includes("Type: ERASE")) return "ERASE";
    if (comment.includes("Type: MERGE")) return "MERGE";
    return "SAVE";
  }

  /**
   * Get Git commit history for a specific file
   *
   * Note: The REST API does not expose a /files/{path}/history endpoint.
   * This method will return a 404 error. File history may need to be accessed
   * through project-level history or external Git tools.
   *
   * @param request - File history request
   * @returns File commit history with pagination
   * @throws Error if endpoint doesn't exist (404)
   */
  async getFileHistory(request: Types.GetFileHistoryRequest): Promise<Types.GetFileHistoryResult> {
    const projectPath = this.buildProjectPath(request.projectId);

    const response = await this.axiosInstance.get(
      `${projectPath}/files/${encodeURIComponent(request.filePath)}/history`,
      {
        params: {
          limit: request.limit || 50,
          offset: request.offset || 0,
        },
      }
    );

    const commits = (response.data.commits && Array.isArray(response.data.commits)) 
      ? response.data.commits.map((fileData: Types.FileData) => ({
          commitHash: fileData.version || "",
          author: fileData.author || { name: "unknown", email: "" },
          timestamp: fileData.modifiedAt || new Date().toISOString(),
          comment: fileData.comment || "",
          commitType: this.parseCommitType(fileData.comment),
          size: fileData.size,
        }))
      : [];

    return {
      filePath: request.filePath,
      commits,
      total: response.data.total || commits.length,
      hasMore: (request.offset || 0) + commits.length < (response.data.total || commits.length),
    };
  }

  /**
   * Get Git commit history for entire project
   *
   * Uses project-based endpoint structure:
   * - /projects/{projectId}/history
   *
   * @param request - Project history request with pagination parameters
   * @returns Project commit history with paginated response
   */
  async getProjectHistory(request: Types.GetProjectHistoryRequest): Promise<Types.GetProjectHistoryResult> {
    const projectPath = this.buildProjectPath(request.projectId);
    const endpoint = `${projectPath}/history`;

    // Build query parameters using OpenAPI 3.0.1 parameter names
    const params: Record<string, unknown> = {
      page: (request.page !== undefined && request.page !== null) ? request.page : 0,
      size: (request.size !== undefined && request.size !== null) ? request.size : 50,
    };
    if (request.search) {
      params.search = request.search;
    }
    if (request.techRevs !== undefined) {
      params.techRevs = request.techRevs;
    }
    if (request.branch) {
      params.branch = request.branch;
    }

    const response = await this.axiosInstance.get<Types.PageResponseProjectRevision_Short>(
      endpoint,
      { params }
    );

    // Convert PageResponseProjectRevision_Short to legacy GetProjectHistoryResult format
    const commits = response.data.content.map((revision) => ({
      commitHash: revision.commitHash || revision.version || "",
      author: revision.author || { name: "unknown", email: "" },
      timestamp: revision.modifiedAt || new Date().toISOString(),
      comment: revision.comment || "",
      commitType: this.parseCommitType(revision.comment),
      filesChanged: revision.filesChanged || 0,
      tablesChanged: revision.tablesChanged,
    }));

    return {
      projectId: request.projectId,
      branch: request.branch || "main",
      commits,
      total: response.data.totalElements || response.data.numberOfElements,
      hasMore: (response.data.pageNumber + 1) < (response.data.totalPages || 1),
    };
  }

}
