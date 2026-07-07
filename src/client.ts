/**
 * OpenL Studio API Client
 *
 * Provides a high-level interface for interacting with OpenL Studio REST API.
 * Handles all HTTP communication, error handling, and response parsing.
 */

import axios, { AxiosInstance, AxiosResponse } from "axios";
import FormData from "form-data";
import type * as Types from "./types.js";
import { AuthenticationManager } from "./auth.js";
import { DEFAULTS, ERROR_LOCAL_REPOSITORY, REPOSITORY_LOCAL } from "./constants.js";
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
 *   personalAccessToken: "openl_pat_…"
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
  /**
   * Gate that serializes the very first cookie-less request so that any
   * requests fired in parallel before the JSESSIONID is captured wait for it.
   * Without this, LLM clients that dispatch multiple tool calls concurrently
   * (typical for Claude Desktop / Cursor when a model emits several tool_use
   * blocks in one turn) each get a fresh studio session, breaking session-
   * scoped state like the compilation registry.
   * Reset to `null` once the cookie has been captured, after which requests
   * proceed in parallel without further serialization.
   */
  private firstRequestGate: Promise<void> | null = null;
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

    // Setup cookie management: extract JSESSIONID from responses and add to requests
    this.setupCookieInterceptors();
  }

  /**
   * Setup interceptors to automatically handle JSESSIONID cookies
   * Extracts JSESSIONID from set-cookie headers and adds it to all subsequent requests
   */
  private setupCookieInterceptors(): void {
    const debug = process.env.DEBUG_COOKIE === "true";

    // Shared helper used by both success and error response paths to release the
    // first-request gate (if this config opened one) so queued requests can fire.
    const releaseFirstRequestGate = (config: unknown): void => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const release = (config as any)?._releaseFirstRequestGate;
      if (release) {
        release();
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (config as any)._releaseFirstRequestGate = undefined;
      }
    };

    // Response interceptor: Extract JSESSIONID from set-cookie headers.
    this.axiosInstance.interceptors.response.use(
      (response) => {
        const setCookieHeader = response.headers['set-cookie'];
        if (setCookieHeader) {
          const cookies = Array.isArray(setCookieHeader) ? setCookieHeader : [setCookieHeader];
          for (const cookie of cookies) {
            const jsessionMatch = cookie.match(/JSESSIONID=([^;]+)/);
            if (jsessionMatch) {
              const previous = this.jsessionId;
              this.jsessionId = jsessionMatch[1];
              if (debug) {
                console.error(
                  `[Cookie] CAPTURE ${response.config?.method?.toUpperCase()} ${response.config?.url} → JSESSIONID=${this.jsessionId.substring(0, 12)}…${previous && previous !== this.jsessionId ? ` (was ${previous.substring(0, 12)}…)` : ""}`
                );
              }
              break;
            }
          }
        }
        // Re-arm the bootstrap gate. Once a JSESSIONID is captured, future
        // requests carry it and need no gate. If THIS was the bootstrap but the
        // response issued no cookie (e.g. GET /repos never sets one), clear the
        // gate too — otherwise siblings waiting on it would wake on a resolved
        // gate with a still-null cookie and each open its own studio session.
        // Clearing it lets the next waiter/incoming request re-bootstrap, so we
        // keep serializing until a cookie actually lands.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const wasBootstrap = Boolean((response.config as any)?._releaseFirstRequestGate);
        if (this.jsessionId || wasBootstrap) {
          this.firstRequestGate = null;
        }
        releaseFirstRequestGate(response.config);
        return response;
      },
      (error) => {
        // Always release the gate on error, otherwise queued requests would
        // wait forever if the bootstrap request failed. Re-arm it when the
        // failed request was the bootstrap so the next waiter re-bootstraps
        // rather than spinning on an already-resolved gate.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        if ((error?.config as any)?._releaseFirstRequestGate) {
          this.firstRequestGate = null;
        }
        releaseFirstRequestGate(error?.config);
        return Promise.reject(error);
      }
    );

    // Request interceptor: bootstrap-gate + add JSESSIONID to Cookie header.
    this.axiosInstance.interceptors.request.use(
      async (config) => {
        // Bootstrap gate: until a JSESSIONID is captured, serialize requests so
        // they share one studio session instead of each opening its own. A
        // sibling waits on the in-flight bootstrap; if that bootstrap returns
        // without a cookie (e.g. GET /repos issues none), the gate is re-armed
        // (see the response interceptor) and the woken sibling loops to become
        // the next bootstrap — so we keep serializing until a cookie lands.
        while (!this.jsessionId) {
          if (this.firstRequestGate) {
            // A sibling is bootstrapping; wait, then re-check the loop condition.
            await this.firstRequestGate;
          } else {
            // We are the bootstrap. Open the gate and remember how to release it.
            let resolveGate!: () => void;
            this.firstRequestGate = new Promise<void>((r) => { resolveGate = r; });
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            (config as any)._releaseFirstRequestGate = resolveGate;
            break;
          }
        }

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
          if (debug) {
            console.error(
              `[Cookie] SEND    ${config.method?.toUpperCase()} ${config.url} ← JSESSIONID=${this.jsessionId.substring(0, 12)}…`
            );
          }
        } else if (debug) {
          console.error(
            `[Cookie] SEND    ${config.method?.toUpperCase()} ${config.url} ← (no cookie)`
          );
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
   * Current `JSESSIONID` captured from a prior HTTP response, or `null` if none
   * has been seen yet. Two consumers rely on this:
   *
   * 1. The STOMP transport, which reuses the same session for the WebSocket
   *    handshake (the studio authenticates STOMP via the HTTP session cookie,
   *    not via STOMP CONNECT headers).
   * 2. The CLI `--cookie-jar` flag, which round-trips this value through a file
   *    so session-coupled flows (notably trace: the debug session is
   *    server-side and keyed by JSESSIONID; every step/inspect/resume call
   *    must present the same cookie) work across separate `npx` invocations.
   */
  public getSessionCookie(): string | null {
    return this.jsessionId;
  }

  /**
   * Get the current authentication method
   */
  public getAuthMethod(): string {
    return this.authManager.getAuthMethod();
  }

  /**
   * Restore a previously captured JSESSIONID so subsequent requests reuse
   * an existing server-side session. Pair with `getSessionCookie()` after
   * a request to round-trip the session through a file or other store.
   *
   * @param value - JSESSIONID value (without the `JSESSIONID=` prefix), or `null` to clear
   */
  public setSessionCookie(value: string | null): void {
    this.jsessionId = value;
  }

  /**
   * Get the `Authorization` header value this client uses for REST. Exposed
   * so non-axios consumers (e.g. the STOMP WebSocket handshake) can attach
   * the same credentials — the studio's REST filter chain authenticates on
   * the WS upgrade just like every other `/rest/*` request.
   */
  public getAuthorizationHeader(): string | undefined {
    return this.authManager.getAuthorizationHeader();
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
   * Resolve a user-supplied repository identifier (id OR display name,
   * case-insensitive) to the canonical repository id used by the OpenL REST
   * API. This is the contract advertised by the tool descriptions under
   * `src/handlers/` — LLMs tend to pass whichever of the two
   * fields they see first in `openl_list_repositories()` output, sometimes
   * with case drift, so we accept both forms.
   *
   * Match order (most specific first to avoid surprises when an id and a
   * name happen to collide):
   *   1. Exact id match
   *   2. Exact name match
   *   3. Case-insensitive id match
   *   4. Case-insensitive name match
   *
   * @param repositoryIdOrName - Repository id (e.g. "design") or display name
   *   (e.g. "Design Repository"); either is accepted, case-insensitively.
   * @returns Canonical repository id (e.g., "design")
   * @throws Error if no repository matches in any of the four checks
   */
  async getRepositoryIdByName(repositoryIdOrName: string): Promise<string> {
    const repositories = await this.listRepositories();

    const exactId = repositories.find(r => r.id === repositoryIdOrName);
    if (exactId) return exactId.id;
    const exactName = repositories.find(r => r.name === repositoryIdOrName);
    if (exactName) return exactName.id;

    const needle = repositoryIdOrName.toLowerCase();
    const ciId = repositories.find(r => r.id.toLowerCase() === needle);
    if (ciId) return ciId.id;
    const ciName = repositories.find(r => r.name.toLowerCase() === needle);
    if (ciName) return ciName.id;

    const available = repositories.map(r => `${r.id} (${r.name})`).join(", ");
    throw new Error(
      `Repository "${repositoryIdOrName}" not found. ` +
      `Available repositories: ${available || "none"}. ` +
      `Use openl_list_repositories() to see all available repositories.`
    );
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
  // Project Creation & Repository Files (repo-mount, direct-to-branch)
  // =============================================================================

  /**
   * Create a new project in a design repository from a ZIP skeleton.
   *
   * Maps to `PUT /repos/{repo}/projects/{name}` (multipart, `template` = zip),
   * which commits the project in a single FULL changeset and returns the commit
   * revision. The repository's default/base branch is used (this endpoint does
   * not accept a branch). A name collision returns HTTP 409.
   *
   * @param repositoryId - Canonical repository id (resolve via getRepositoryIdByName)
   * @param projectName - New project name (also the project folder)
   * @param templateZip - ZIP archive whose root entries become the project files
   * @param options - Optional commit comment and (mapped-folder repos only) path
   * @returns The created project's revision (commit SHA) and branch (if supported)
   */
  async createProjectFromZip(
    repositoryId: string,
    projectName: string,
    templateZip: Buffer,
    options?: { comment?: string; path?: string }
  ): Promise<Types.CreateProjectResult> {
    const form = new FormData();
    form.append("template", templateZip, {
      filename: "template.zip",
      contentType: "application/zip",
    });
    if (options?.comment) form.append("comment", options.comment);
    if (options?.path) form.append("path", options.path);

    const response = await this.axiosInstance.put<Types.CreateProjectResult>(
      `/repos/${encodeURIComponent(repositoryId)}/projects/${encodeURIComponent(projectName)}`,
      form,
      { headers: form.getHeaders() }
    );
    return response.data;
  }

  /**
   * Copy a file or folder within a design repository on a single branch.
   *
   * Maps to `POST /repos/{repo}/file-copy` with a {sourcePath, destinationPath}
   * body. Copying a project folder recursively copies all of its contents. The
   * copy is committed file-by-file (one commit per file, not atomic). A
   * destination collision returns HTTP 409; a missing source returns HTTP 404.
   *
   * @param repositoryId - Canonical repository id
   * @param sourcePath - Mount-relative source path (e.g. the source project name)
   * @param destinationPath - Mount-relative destination path (e.g. the new project name)
   * @param branch - Optional branch (source and destination share this branch)
   */
  async copyRepositoryFile(
    repositoryId: string,
    sourcePath: string,
    destinationPath: string,
    branch?: string
  ): Promise<void> {
    const body: Types.FilePathPairRequest = { sourcePath, destinationPath };
    await this.axiosInstance.post(
      `/repos/${encodeURIComponent(repositoryId)}/file-copy`,
      body,
      branch ? { params: { branch } } : undefined
    );
  }

  /**
   * Read a single file's contents from a design repository branch.
   *
   * Maps to `GET /repos/{repo}/files/{path}`. Returns the file content as a
   * UTF-8 string, or `null` if the file does not exist (HTTP 404).
   *
   * @param repositoryId - Canonical repository id
   * @param filePath - Mount-relative file path (e.g. "MyProject/rules.xml")
   * @param branch - Optional branch
   */
  async getRepositoryFileContent(
    repositoryId: string,
    filePath: string,
    branch?: string
  ): Promise<string | null> {
    const encodedPath = filePath.split("/").map(encodeURIComponent).join("/");
    try {
      const response = await this.axiosInstance.get<ArrayBuffer>(
        `/repos/${encodeURIComponent(repositoryId)}/files/${encodedPath}`,
        {
          responseType: "arraybuffer",
          params: branch ? { branch } : undefined,
          headers: { Accept: "*/*" },
        }
      );
      return Buffer.from(response.data).toString("utf-8");
    } catch (error: unknown) {
      if (axios.isAxiosError(error) && error.response?.status === 404) {
        return null;
      }
      throw error;
    }
  }

  /**
   * Download a repository folder (e.g. a whole project) as a ZIP archive.
   *
   * Maps to `GET /repos/{repo}/files/{path}/?download=true`. The backend streams
   * the folder's readable files into a ZIP whose entry names are RELATIVE to the
   * folder — downloading a project folder therefore yields an archive with the
   * project files at the archive root, exactly the layout the create-from-zip
   * endpoint (PUT /repos/{repo}/projects/{name}) expects. A missing folder
   * returns HTTP 404.
   *
   * @param repositoryId - Canonical repository id
   * @param folderPath - Mount-relative folder path (e.g. the project name)
   * @param branch - Optional branch
   * @returns The ZIP archive bytes
   */
  async downloadRepositoryFolderZip(
    repositoryId: string,
    folderPath: string,
    branch?: string
  ): Promise<Buffer> {
    // Trailing slash marks the path as a folder to the files API.
    const encodedPath = folderPath
      .replace(/\/+$/, "")
      .split("/")
      .map(encodeURIComponent)
      .join("/");
    const params: Record<string, string> = { download: "true" };
    if (branch) params.branch = branch;

    const response = await this.axiosInstance.get<ArrayBuffer>(
      `/repos/${encodeURIComponent(repositoryId)}/files/${encodedPath}/`,
      {
        responseType: "arraybuffer",
        params,
        headers: { Accept: "*/*" },
      }
    );
    return Buffer.from(response.data);
  }

  /**
   * Replace a single file's contents on a design repository branch.
   *
   * Maps to the raw `PUT /repos/{repo}/files/{path}` variant (updateResource).
   * A non-JSON, non-multipart Content-Type is used so the request routes to the
   * raw update handler (the JSON variant is the create-folder operation).
   *
   * @param repositoryId - Canonical repository id
   * @param filePath - Mount-relative file path
   * @param content - New file content
   * @param branch - Optional branch
   */
  async updateRepositoryFileRaw(
    repositoryId: string,
    filePath: string,
    content: Buffer | string,
    branch?: string
  ): Promise<void> {
    const encodedPath = filePath.split("/").map(encodeURIComponent).join("/");
    const body = Buffer.isBuffer(content) ? content : Buffer.from(content, "utf-8");
    await this.axiosInstance.put(
      `/repos/${encodeURIComponent(repositoryId)}/files/${encodedPath}`,
      body,
      {
        headers: { "Content-Type": "application/xml" },
        params: branch ? { branch } : undefined,
      }
    );
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
   * Get post-compilation project status (compile state, diagnostics, pending changes).
   * Read-only — does not trigger compilation. Works for all repositories including "local".
   *
   * @param projectId - Opaque project ID from the backend.
   * @param branch - Optional branch name. When provided, the backend asserts it matches
   *                 the project's currently opened branch (409 on mismatch).
   */
  async getProjectStatus(projectId: string, branch?: string): Promise<Types.ProjectStatusView> {
    const url = `${this.buildProjectPath(projectId)}/status`;
    const params: Record<string, string> = {};
    if (branch) {
      params.branch = branch;
    }
    const response = await this.axiosInstance.get<Types.ProjectStatusView>(url, { params });
    return response.data;
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

  // =============================================================================
  // Project Files (BETA)
  // =============================================================================
  //
  // Thin wrappers over the "Projects: Files (BETA)" REST API
  // (/projects/{projectId}/files/{path}, /file-search, /file-copy, /file-move).
  // Unlike the legacy downloadFile (Excel-only, path-guessing), these
  // operate on ANY repo file by exact project-relative path and expose the raw
  // API surface (branch, version, conflictPolicy, glob/content search, copy/move).

  /**
   * Percent-encode each segment of a project-relative file path while preserving
   * '/' separators and any trailing slash (which denotes a folder to the API).
   * Leading slashes are dropped — paths are always project-relative.
   */
  private encodeProjectFilePath(path: string): string {
    const trimmed = (path ?? "").replace(/^\/+/, "");
    if (trimmed === "") return "";
    const hasTrailingSlash = trimmed.endsWith("/");
    const segments = trimmed.split("/").filter((seg) => seg.length > 0);
    this.assertSafeProjectPath(path);
    const encoded = segments.map(encodeURIComponent).join("/");
    return hasTrailingSlash ? `${encoded}/` : encoded;
  }

  /**
   * Defense-in-depth path validation: reject '.'/'..' segments so a caller-supplied
   * path can't escape the project subtree. URL-path operations (read/write/delete)
   * also need this because encodeURIComponent leaves '.'/'..' untouched (both are
   * RFC 3986 unreserved) and a downstream URL normalizer could collapse them; body-
   * path operations (copy/move source & destination, search 'from') don't go through
   * encodeProjectFilePath, so they call this directly rather than trusting the backend.
   *
   * @param path - Project-relative path to validate (no-op for empty/undefined).
   */
  private assertSafeProjectPath(path: string | undefined): void {
    if (!path) return;
    const segments = path.split("/").filter((seg) => seg.length > 0);
    if (segments.some((seg) => seg === "." || seg === "..")) {
      throw new Error(
        "Invalid path: '.' and '..' segments are not allowed; paths must be project-relative."
      );
    }
  }

  /**
   * Normalize a file path carried in a JSON request BODY (copy/move source &
   * destination, search 'from'): strip leading slashes so it's consistently
   * project-relative (matching the URL-path encoder), and validate it. Unlike
   * encodeProjectFilePath this does NOT percent-encode — body paths are sent raw
   * in JSON, so encoding would corrupt names containing spaces or reserved chars
   * (e.g. "My File.xlsx" -> "My%20File.xlsx", a literal name the backend can't find).
   */
  private normalizeBodyPath(path: string): string {
    const normalized = (path ?? "").replace(/^\/+/, "");
    this.assertSafeProjectPath(normalized);
    return normalized;
  }

  /**
   * Read a file's bytes, a file's metadata, or a folder listing from a project.
   *
   * Maps to `GET /projects/{projectId}/files/{path}`. The single endpoint serves
   * several response shapes depending on the path and query params:
   *  - file path                -> the file's raw bytes (Content-Disposition: attachment)
   *  - file path + view=meta    -> JSON metadata (FsNode)
   *  - folder path              -> JSON array of FsNode (or a tree when viewMode=NESTED)
   *  - folder path + download   -> a ZIP archive of the folder (attachment)
   *
   * The raw body is returned as a Buffer together with the Content-Type and
   * Content-Disposition headers so the caller can distinguish a file/ZIP download
   * (attachment) from a JSON listing/metadata response and decode accordingly.
   *
   * @param projectId - Opaque project ID returned by backend.
   * @param path - Project-relative path; empty or trailing-slash lists a folder.
   * @param options - Query parameters mirroring the REST API.
   */
  async readProjectFile(
    projectId: string,
    path: string,
    options?: {
      view?: "meta";
      download?: boolean;
      recursive?: boolean;
      viewMode?: "FLAT" | "NESTED";
      extensions?: string[];
      namePattern?: string;
      foldersOnly?: boolean;
      version?: string;
      branch?: string;
      fields?: string;
    }
  ): Promise<Types.ProjectFileResponse> {
    const projectPath = this.buildProjectPath(projectId);
    const encodedPath = this.encodeProjectFilePath(path);

    const params: Record<string, unknown> = {};
    if (options?.view) params.view = options.view;
    if (options?.download) params.download = "true";
    if (options?.recursive !== undefined) params.recursive = options.recursive;
    if (options?.viewMode) params.viewMode = options.viewMode;
    if (options?.extensions && options.extensions.length > 0) {
      // Spring binds a Set<String> query param from either repeated keys or a
      // comma-separated value; the comma form is the most portable.
      params.extensions = options.extensions.join(",");
    }
    if (options?.namePattern) params.namePattern = options.namePattern;
    if (options?.foldersOnly !== undefined) params.foldersOnly = options.foldersOnly;
    if (options?.version) params.version = options.version;
    if (options?.branch) params.branch = options.branch;
    if (options?.fields) params.fields = options.fields;

    const response = await this.axiosInstance.get<ArrayBuffer>(
      `${projectPath}/files/${encodedPath}`,
      {
        responseType: "arraybuffer",
        params,
        headers: { Accept: "*/*" },
      }
    );

    const headers = (response.headers ?? {}) as Record<string, unknown>;
    const headerValue = (name: string): string => {
      const v = headers[name] ?? headers[name.toLowerCase()];
      return typeof v === "string" ? v : "";
    };
    return {
      data: Buffer.from(response.data),
      contentType: headerValue("content-type").toLowerCase(),
      contentDisposition: headerValue("content-disposition"),
    };
  }

  /**
   * Write (create or replace) a file in a project's working copy.
   *
   * CREATE-only: maps to `POST /projects/{projectId}/files/{path}` with the raw
   * bytes as an `application/octet-stream` body. POST is create semantics — a
   * pre-existing target yields HTTP 409 (the backend does NOT apply conflictPolicy
   * to a single-file POST; to replace an existing file use {@link updateProjectFile}
   * / PUT). The write lands in the project working copy (NOT committed to Git) —
   * commit via {@link saveProject}.
   *
   * @param projectId - Opaque project ID returned by backend.
   * @param path - Project-relative file path.
   * @param content - Raw file bytes.
   * @param options - createFolders / branch.
   * @returns The backend's file-metadata response (may be empty).
   */
  async writeProjectFile(
    projectId: string,
    path: string,
    content: Buffer,
    options?: { createFolders?: boolean; branch?: string }
  ): Promise<unknown> {
    const projectPath = this.buildProjectPath(projectId);
    const encodedPath = this.encodeProjectFilePath(path);

    const params: Record<string, unknown> = {};
    if (options?.createFolders !== undefined) params.createFolders = options.createFolders;
    if (options?.branch) params.branch = options.branch;

    const response = await this.axiosInstance.post(
      `${projectPath}/files/${encodedPath}`,
      content,
      {
        headers: { "Content-Type": "application/octet-stream" },
        params,
      }
    );
    return response.data;
  }

  /**
   * OVERWRITE an existing file: maps to `PUT /projects/{projectId}/files/{path}`
   * with the raw bytes as an `application/octet-stream` body (the backend's
   * `updateResource`). PUT is update semantics — it replaces the content of an
   * EXISTING file in place (HTTP 204) and returns 404 if the file does not exist
   * (it does not create). The update lands in the project working copy (NOT
   * committed to Git) — commit via {@link saveProject}.
   *
   * @param projectId - Opaque project ID returned by backend.
   * @param path - Project-relative file path (must already exist).
   * @param content - Raw replacement bytes.
   * @param options - branch.
   */
  async updateProjectFile(
    projectId: string,
    path: string,
    content: Buffer,
    options?: { branch?: string }
  ): Promise<void> {
    const projectPath = this.buildProjectPath(projectId);
    const encodedPath = this.encodeProjectFilePath(path);
    await this.axiosInstance.put(
      `${projectPath}/files/${encodedPath}`,
      content,
      {
        headers: { "Content-Type": "application/octet-stream" },
        params: options?.branch ? { branch: options.branch } : undefined,
      }
    );
  }

  /**
   * Delete a file or folder from a project by its project-relative path.
   *
   * Maps to `DELETE /projects/{projectId}/files/{path}` (HTTP 204). The backend
   * auto-cleans dangling references to the deleted resource from project config.
   *
   * @param projectId - Opaque project ID returned by backend.
   * @param path - Project-relative path to the resource.
   * @param options - Optional branch.
   */
  async deleteProjectFile(
    projectId: string,
    path: string,
    options?: { branch?: string }
  ): Promise<void> {
    const projectPath = this.buildProjectPath(projectId);
    const encodedPath = this.encodeProjectFilePath(path);
    await this.axiosInstance.delete(`${projectPath}/files/${encodedPath}`, {
      params: options?.branch ? { branch: options.branch } : undefined,
    });
  }

  /**
   * Search a project's files/folders by glob pattern, extensions, type and a
   * case-insensitive content substring.
   *
   * Maps to `POST /projects/{projectId}/file-search` (body = FileSearchQuery).
   * Returns the matching nodes. SUBTREE scope (default) may target a historical
   * `version`; ANCESTORS walks up to the repository root.
   *
   * @param projectId - Opaque project ID returned by backend.
   * @param query - Search criteria (all fields optional).
   * @param options - branch / fields query params.
   */
  async searchProjectFiles(
    projectId: string,
    query: Types.FileSearchQuery,
    options?: { branch?: string; fields?: string }
  ): Promise<Types.FsNode[]> {
    const body = query.from !== undefined ? { ...query, from: this.normalizeBodyPath(query.from) } : query;
    const projectPath = this.buildProjectPath(projectId);
    const params: Record<string, unknown> = {};
    if (options?.branch) params.branch = options.branch;
    if (options?.fields) params.fields = options.fields;

    const response = await this.axiosInstance.post<Types.FsNode[]>(
      `${projectPath}/file-search`,
      body,
      Object.keys(params).length > 0 ? { params } : undefined
    );
    return response.data;
  }

  /**
   * Resolve the chain of AGENTS.md files that apply to a project, per the
   * AGENTS.md specification: start at the project directory (or a sub-folder of
   * it when `folder` is given), walk UP through every parent directory to the
   * repository root, and collect the AGENTS.md found at each level. Levels with
   * no AGENTS.md are skipped (not an error); a project with none anywhere yields
   * an empty array.
   *
   * Implemented as a fixed ANCESTORS-scope `file-search` (`from = <folder>/AGENTS.md`),
   * which returns every same-named ancestor nearest-first WITH its content.
   * Proximity is carried by the array order alone (nearest-first); the
   * `openl_get_project_agent_context` tool renders them as one document via
   * `formatAgentsDocument`.
   *
   * @param projectId - Project ID or name (same resolution as other project calls).
   * @param options - `folder`: project-relative sub-folder to start the walk from
   *                   (for "the AGENTS.md nearest the edited file"); `branch`: pin
   *                   the project's branch.
   * @returns AGENTS.md files ordered nearest-first; empty array when none exist.
   */
  async getProjectAgentContext(
    projectId: string,
    options?: { folder?: string; branch?: string }
  ): Promise<Types.AgentsFile[]> {
    const folder = this.trimSlashes(options?.folder ?? "");
    const from = folder ? `${folder}/AGENTS.md` : "AGENTS.md";

    const nodes = await this.searchProjectFiles(
      projectId,
      { scope: "ANCESTORS", from },
      options?.branch ? { branch: options.branch } : undefined
    );

    return nodes.map((node) => ({
      path: node.path,
      content: node.content ?? "",
      size: node.size,
      lastModified: node.lastModified,
    }));
  }

  /** Strip leading and trailing '/' from a path (used to normalize the AGENTS.md `folder`). */
  private trimSlashes(path: string): string {
    return (path ?? "").replace(/^\/+|\/+$/g, "");
  }

  /**
   * Copy a file within a project to a new location.
   *
   * Maps to `POST /projects/{projectId}/file-copy` (body = {sourcePath,
   * destinationPath}, HTTP 201). Intermediate destination folders are created
   * automatically. A destination collision returns HTTP 409 (no overwrite option).
   *
   * @param projectId - Opaque project ID returned by backend.
   * @param pair - Source and destination project-relative paths.
   * @param options - Optional branch.
   */
  async copyProjectFile(
    projectId: string,
    pair: Types.FilePathPairRequest,
    options?: { branch?: string }
  ): Promise<void> {
    const body: Types.FilePathPairRequest = {
      sourcePath: this.normalizeBodyPath(pair.sourcePath),
      destinationPath: this.normalizeBodyPath(pair.destinationPath),
    };
    const projectPath = this.buildProjectPath(projectId);
    await this.axiosInstance.post(
      `${projectPath}/file-copy`,
      body,
      options?.branch ? { params: { branch: options.branch } } : undefined
    );
  }

  /**
   * Move or rename a file within a project.
   *
   * Maps to `POST /projects/{projectId}/file-move` (body = {sourcePath,
   * destinationPath}, HTTP 204). Intermediate destination folders are created
   * automatically; the source file is deleted after the move.
   *
   * @param projectId - Opaque project ID returned by backend.
   * @param pair - Source and destination project-relative paths.
   * @param options - Optional branch.
   */
  async moveProjectFile(
    projectId: string,
    pair: Types.FilePathPairRequest,
    options?: { branch?: string }
  ): Promise<void> {
    const body: Types.FilePathPairRequest = {
      sourcePath: this.normalizeBodyPath(pair.sourcePath),
      destinationPath: this.normalizeBodyPath(pair.destinationPath),
    };
    const projectPath = this.buildProjectPath(projectId);
    await this.axiosInstance.post(
      `${projectPath}/file-move`,
      body,
      options?.branch ? { params: { branch: options.branch } } : undefined
    );
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
   * @param raw - If true, returns raw 2D cell matrix instead of parsed table
   * @param options - Raw-view-only options: read the matrix in row slices
   *   (`startRow`/`maxRows`) and/or with per-cell Excel styles (`styles`)
   * @returns Parsed table view or raw table view depending on raw flag
   */
  async getTable(projectId: string, tableId: string, raw: true, options?: Types.RawTableViewOptions): Promise<Types.RawTableView>;
  async getTable(projectId: string, tableId: string, raw?: false): Promise<Types.TableView>;
  async getTable(projectId: string, tableId: string, raw?: boolean, options?: Types.RawTableViewOptions): Promise<Types.TableView | Types.RawTableView> {
    const projectPath = this.buildProjectPath(projectId);
    const params = raw
      ? {
          raw: true,
          ...(options?.startRow !== undefined && { startRow: options.startRow }),
          ...(options?.maxRows !== undefined && { maxRows: options.maxRows }),
          ...(options?.styles && { styles: true }),
        }
      : undefined;
    const response = await this.axiosInstance.get<Types.TableView | Types.RawTableView>(
      `${projectPath}/tables/${encodeURIComponent(tableId)}`,
      { params }
    );
    return response.data;
  }

  /**
   * Extract the table's post-write id reported by an update/append response.
   *
   * Studio PR #1778 (EPBDS-16086): a write that RELOCATES the table (it had no
   * room to grow in place, so it moved to a free area and its content/position-
   * derived id changed) responds 200 with body `{ id }` and a `Location` header
   * pointing at the table under its new id; an in-place write responds 204.
   * Studios without that change always respond 204/empty.
   *
   * @returns the new table id when the studio reported one, else undefined
   *   (the id is unchanged on a current studio, or unknown on an older one —
   *   the caller falls back to resolving it heuristically).
   */
  private parseWrittenTableId(response: AxiosResponse): string | undefined {
    const body = response.data as { id?: unknown } | undefined;
    if (body && typeof body.id === "string" && body.id.length > 0) {
      return body.id;
    }
    // Fallback: last `/tables/{id}` segment of the Location header. Prefer the
    // body above — Location is request-derived and a reverse proxy may rewrite it.
    const headers = (response.headers ?? {}) as Record<string, unknown>;
    const location = headers.location ?? headers.Location;
    if (typeof location === "string") {
      const match = location.match(/\/tables\/([^/?#]+)/);
      if (match) {
        return decodeURIComponent(match[1]);
      }
    }
    return undefined;
  }

  /**
   * Update table content
   *
   * @param projectId - Opaque project ID returned by backend.
   * @param tableId - Table identifier
   * @param view - Updated table view with modifications (MUST include full table structure from get_table)
   * @param comment - Optional comment describing the changes (NOTE: not supported by OpenAPI schema, will be ignored)
   * @returns the table's id after the write when the studio relocated it (id
   *   changed), otherwise undefined (204 — id unchanged, or older studio)
   * @throws Error if view is missing required fields
   */
  async updateTable(
    projectId: string,
    tableId: string,
    view: Types.EditableTableView
  ): Promise<string | undefined> {
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
    const response = await this.axiosInstance.put(
      `${projectPath}/tables/${encodeURIComponent(tableId)}`,
      view
    );
    // 204 No Content when the id is unchanged; 200 + { id } + Location when relocated.
    return this.parseWrittenTableId(response);
  }

  /**
   * Append lines to a project table
   *
   * @param projectId - Opaque project ID returned by backend.
   * @param tableId - Table identifier
   * @param appendData - Data to append with fields and table type
   * @returns the table's id after the append when the studio relocated it (id
   *   changed), otherwise undefined (204 — id unchanged, or older studio)
   */
  async appendProjectTable(
    projectId: string,
    tableId: string,
    appendData: Types.AppendTableView
  ): Promise<string | undefined> {
    const projectPath = this.buildProjectPath(projectId);
    const response = await this.axiosInstance.post(
      `${projectPath}/tables/${encodeURIComponent(tableId)}/lines`,
      appendData
    );
    return this.parseWrittenTableId(response);
  }

  /**
   * Apply a single in-place edit to a table's raw source (append, insert,
   * delete, update, merge or unmerge a row/column/cell). The table is handled
   * in raw format regardless of its type.
   *
   * @param projectId - Opaque project ID returned by backend.
   * @param tableId - Table identifier
   * @param action - The edit to apply (operation + target)
   * @returns the table's id after the edit when the studio relocated it (id
   *   changed), otherwise undefined (204 — id unchanged)
   */
  async editTableSource(
    projectId: string,
    tableId: string,
    action: Types.RawTableSourceAction
  ): Promise<string | undefined> {
    const projectPath = this.buildProjectPath(projectId);
    const response = await this.axiosInstance.post(
      `${projectPath}/tables/${encodeURIComponent(tableId)}/actions`,
      action
    );
    // 204 No Content when the id is unchanged; 200 + { id } + Location when relocated.
    return this.parseWrittenTableId(response);
  }

  /**
   * Delete a table from the currently opened project. The whole table area is
   * cleared from the sheet regardless of table type, so the table no longer
   * exists once the project is recompiled.
   *
   * @param projectId - Opaque project ID returned by backend.
   * @param tableId - Table identifier
   * @returns nothing (204 No Content on success)
   */
  async deleteTable(projectId: string, tableId: string): Promise<void> {
    const projectPath = this.buildProjectPath(projectId);
    await this.axiosInstance.delete(
      `${projectPath}/tables/${encodeURIComponent(tableId)}`
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

  // =============================================================================
  // Trace Debug API (BETA) — interactive debugger
  //
  // The debug session is server-side and bound to the HTTP session (JSESSIONID):
  // the cookie interceptors above carry the same session across all calls of one
  // debug flow. One active session per user; starting a new one terminates the
  // previous.
  // =============================================================================

  /**
   * Start an interactive debug session for a table and run it to the first
   * suspension (the table entry when stopAtEntry, otherwise the first breakpoint)
   * or to a terminal state. Returns the initial execution stack.
   *
   * For TestSuiteMethod: use testRanges (e.g. "1-3,5").
   * For regular methods: use inputJson with { params: {...}, runtimeContext?: {...} }.
   * A restart with neither re-runs the remembered last input (replay).
   */
  async startTrace(request: Types.StartTraceRequest): Promise<Types.DebugStackView> {
    const projectPath = this.buildProjectPath(request.projectId);
    const params = new URLSearchParams({ tableId: request.tableId });
    if (request.testRanges) params.set("testRanges", request.testRanges);
    if (request.fromModule) params.set("fromModule", request.fromModule);
    if (request.stopAtEntry != null) params.set("stopAtEntry", String(request.stopAtEntry));
    if (request.profiling != null) params.set("profiling", String(request.profiling));

    const body = request.inputJson != null
      ? (typeof request.inputJson === "string" ? request.inputJson : JSON.stringify(request.inputJson))
      : undefined;

    const response = await this.axiosInstance.post<Types.DebugStackView>(
      `${projectPath}/trace?${params.toString()}`,
      body,
      body != null ? { headers: { "Content-Type": "application/json" } } : undefined
    );
    return response.data;
  }

  /**
   * Lightweight status poll of the debug session.
   */
  async getTraceStatus(projectId: string): Promise<Types.DebugStatusView> {
    const projectPath = this.buildProjectPath(projectId);
    const response = await this.axiosInstance.get<Types.DebugStatusView>(
      `${projectPath}/trace/status`
    );
    return response.data;
  }

  /**
   * Read the execution stack (frames root → current). Readable while suspended
   * or terminal; 409 while the worker is still running.
   */
  async getTraceStack(projectId: string): Promise<Types.DebugStackView> {
    const projectPath = this.buildProjectPath(projectId);
    const response = await this.axiosInstance.get<Types.DebugStackView>(
      `${projectPath}/trace/stack`
    );
    return response.data;
  }

  /**
   * Step once (into / over / out) and return the new stack once the worker
   * re-suspends (the backend waits synchronously, bounded ~30s).
   */
  async traceStep(projectId: string, type: "into" | "over" | "out"): Promise<Types.DebugStackView> {
    const projectPath = this.buildProjectPath(projectId);
    const response = await this.axiosInstance.post<Types.DebugStackView>(
      `${projectPath}/trace/step`,
      undefined,
      { params: { type } }
    );
    return response.data;
  }

  /**
   * Resume execution to the next breakpoint or completion. Asynchronous:
   * returns 202 immediately — poll getTraceStatus until it leaves running,
   * then read getTraceStack.
   */
  async traceResume(projectId: string): Promise<void> {
    const projectPath = this.buildProjectPath(projectId);
    await this.axiosInstance.post(`${projectPath}/trace/resume`);
  }

  /**
   * Freeze and read the variables of a suspended frame. `fields` is the
   * standard response projection (nested selection supported) used to keep
   * value schemas and other bulk out of the agent's token budget.
   */
  async getTraceFrameVariables(
    projectId: string,
    frameIndex: number,
    fields?: string
  ): Promise<Types.DebugFrameVariables> {
    const projectPath = this.buildProjectPath(projectId);
    const response = await this.axiosInstance.get<Types.DebugFrameVariables>(
      `${projectPath}/trace/frames/${frameIndex}/variables`,
      { params: fields ? { fields } : undefined }
    );
    return response.data;
  }

  /**
   * Execution highlight overlay for a frame's table, keyed by A1 cell address.
   * Merge with the raw table grid (getTable(..., raw: true)).
   */
  async getTraceFrameHighlights(
    projectId: string,
    frameIndex: number
  ): Promise<Types.CellHighlight[]> {
    const projectPath = this.buildProjectPath(projectId);
    const response = await this.axiosInstance.get<Types.CellHighlight[]>(
      `${projectPath}/trace/frames/${frameIndex}/highlights`
    );
    return response.data;
  }

  /**
   * Active breakpoint keys. Session-scoped, persist across runs, work without
   * an active debug session.
   */
  async getTraceBreakpoints(projectId: string): Promise<string[]> {
    const projectPath = this.buildProjectPath(projectId);
    const response = await this.axiosInstance.get<string[]>(
      `${projectPath}/trace/breakpoints`
    );
    return response.data;
  }

  /**
   * Replace the whole breakpoint set (effective on the next frame enter /
   * current-line change).
   */
  async setTraceBreakpoints(projectId: string, uris: string[]): Promise<void> {
    const projectPath = this.buildProjectPath(projectId);
    await this.axiosInstance.put(`${projectPath}/trace/breakpoints`, { uris });
  }

  /**
   * Rule tables a breakpoint can be set on, deduplicated by name. With an
   * active session only tables reachable from the traced table are returned.
   */
  async getTraceBreakpointTables(projectId: string): Promise<Types.BreakpointTableView[]> {
    const projectPath = this.buildProjectPath(projectId);
    const response = await this.axiosInstance.get<Types.BreakpointTableView[]>(
      `${projectPath}/trace/breakpoint-tables`
    );
    return response.data;
  }

  /**
   * Get lazy-loaded parameter value. `fields` is the standard response
   * projection — used to drop the value's JSON Schema from the default reply.
   */
  async getTraceParameter(
    projectId: string,
    parameterId: number,
    fields?: string
  ): Promise<Types.TraceParameterValue> {
    const projectPath = this.buildProjectPath(projectId);
    const response = await this.axiosInstance.get<Types.TraceParameterValue>(
      `${projectPath}/trace/parameters/${parameterId}`,
      { params: fields ? { fields } : undefined }
    );
    return response.data;
  }

  /**
   * Terminate the debug session and clear the parameter registry. Idempotent.
   */
  async stopTrace(projectId: string): Promise<void> {
    const projectPath = this.buildProjectPath(projectId);
    await this.axiosInstance.delete(`${projectPath}/trace`);
  }

}
