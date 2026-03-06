/**
 * Authentication module for OpenL MCP Server
 *
 * Supports multiple authentication methods:
 * - Basic Authentication (username/password)
 * - Personal Access Token (PAT)
 */

import { AxiosInstance, InternalAxiosRequestConfig } from "axios";
import type * as Types from "./types.js";
import { HEADERS } from "./constants.js";
import { extractApiErrorInfo } from "./utils.js";

/**
 * Check if debug logging is enabled (via environment variable)
 */
const DEBUG_AUTH = process.env.DEBUG_AUTH === "true" || process.env.DEBUG === "true";

/**
 * Cache of logged authentication configs to prevent duplicate logging
 * Key: hash of config (baseUrl + auth method)
 */
const loggedAuthConfigs = new Set<string>();

/**
 * Authentication manager for OpenL Studio API
 *
 * Handles:
 * - Token lifecycle management
 * - Automatic token refresh
 * - Request/response interceptors
 * - Multiple authentication methods
 */
export class AuthenticationManager {
  private config: Types.OpenLConfig;
  private configuredInstances: WeakSet<AxiosInstance> = new WeakSet();

  constructor(config: Types.OpenLConfig) {
    this.config = config;
  }

  /**
   * Configure authentication interceptors for an Axios instance
   *
   * @param axiosInstance - The Axios instance to configure
   */
  public setupInterceptors(axiosInstance: AxiosInstance): void {
    // Prevent duplicate interceptor registration for the same instance
    if (this.configuredInstances.has(axiosInstance)) {
      return;
    }
    this.configuredInstances.add(axiosInstance);
    
    // Clear any existing interceptors to prevent duplication
    // Note: We check configuredInstances first to avoid clearing interceptors from other managers
    axiosInstance.interceptors.request.clear();
    axiosInstance.interceptors.response.clear();
    
    // Request interceptor: Add authentication headers
    axiosInstance.interceptors.request.use(
      async (config) => {
        // Early return if this config has already been processed
        // This prevents duplicate processing if interceptor is called multiple times
        if ((config as any)._authHeadersAdded) {
          return config;
        }
        
        const authConfig = await this.addAuthHeaders(config);
        
        return authConfig;
      },
      (error) => Promise.reject(error)
    );

    // Response interceptor: Handle 401 errors with token refresh
    axiosInstance.interceptors.response.use(
      (response) => {
        return response;
      },
      async (error) => {
        // Original request config available if needed for debugging
        void error.config;

        // Enhanced 401 error handling with API error extraction
        if (error.response && error.response.status === 401) {
          const fullUrl = `${(error.config && error.config.baseURL) || ''}${(error.config && error.config.url) || ''}`;
          const authMethod = this.getAuthMethod();
          const apiErrorInfo = extractApiErrorInfo(error.response.data, 401);
          
          const errorMessage = apiErrorInfo.message || 'Unauthorized';
          console.error(`[Auth] 401 Unauthorized: ${errorMessage} (${authMethod})`);
          
          if (DEBUG_AUTH) {
            console.error(`[Auth] URL: ${fullUrl}`);
            if (apiErrorInfo.code) {
              console.error(`[Auth] Error Code: ${apiErrorInfo.code}`);
            }
          }
        }

        return Promise.reject(error);
      }
    );
  }

  /**
   * Add authentication headers to a request
   *
   * @param config - Axios request configuration
   * @returns Modified request configuration with auth headers
   */
  private async addAuthHeaders(
    config: InternalAxiosRequestConfig
  ): Promise<InternalAxiosRequestConfig> {
    // Check if this config has already been processed (to avoid duplicate logging)
    // Use a flag in the config object itself to track processing
    if ((config as any)._authHeadersAdded) {
      return config;
    }
    
    if (!config.headers) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      config.headers = {} as any;
    }

    // Check if auth headers are already set (to avoid duplicate logging)
    const authHeaderAlreadySet = config.headers[HEADERS.AUTHORIZATION];

    // Create a unique key for this auth config to prevent duplicate logging
    const authConfigKey = `${this.config.baseUrl || ''}:${this.config.personalAccessToken ? 'PAT' : this.config.username ? 'Basic' : 'None'}`;
    const shouldLogAuth = !authHeaderAlreadySet && !loggedAuthConfigs.has(authConfigKey);

    // Add authentication based on method priority:
    // 1. Personal Access Token
    // 2. Basic Auth
    if (this.config.personalAccessToken) {
      // Build authorization header
      const pat = this.config.personalAccessToken;
      const authHeaderValue = `Token ${pat}`;
      config.headers[HEADERS.AUTHORIZATION] = authHeaderValue;
      
      // Log only once per unique config (to avoid duplicate logging)
      if (shouldLogAuth) {
        loggedAuthConfigs.add(authConfigKey);
        // Simplified logging - only essential info; explicitly state we use "Token" (not Bearer) for OpenL API
        const isValidFormat = pat.startsWith('openl_pat_');
        console.error(`[Auth] 🔐 PAT Authentication (${isValidFormat ? 'valid format' : '⚠️  invalid format'}) | Header: Authorization: Token <PAT>`);
        if (!isValidFormat) {
          console.error(`[Auth]   ⚠️  WARNING: PAT should start with 'openl_pat_'`);
        }
      }
    } else if (this.config.username && this.config.password) {
      // Never log password, only username
      const auth = Buffer.from(
        `${this.config.username}:${this.config.password}`
      ).toString("base64");
      config.headers[HEADERS.AUTHORIZATION] = `Basic ${auth}`;
      // Single log message (only once per unique config)
      if (shouldLogAuth) {
        loggedAuthConfigs.add(authConfigKey);
        console.error(`[Auth] 🔐 Basic Auth: username=${this.config.username}`);
      }
    } else {
      // Log only once per unique config
      if (shouldLogAuth) {
        loggedAuthConfigs.add(authConfigKey);
        console.error(`[Auth] ⚠️  No authentication method configured`);
      }
    }

    // Mark this config as processed to prevent duplicate processing
    (config as any)._authHeadersAdded = true;

    return config;
  }

  /**
   * Get the current authentication method being used
   *
   * @returns Human-readable authentication method name
   */
  public getAuthMethod(): string {
    if (this.config.personalAccessToken) {
      return "Personal Access Token";
    } else if (this.config.username && this.config.password) {
      return "Basic Auth";
    } else if (this.config.username || this.config.password) {
      return "Incomplete Basic Auth";
    } else {
      return "No Auth";
    }
  }
}
