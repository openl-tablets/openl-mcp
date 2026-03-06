/**
 * Utility functions for the OpenL MCP Server
 */

import { createHash } from "crypto";
import { exec } from "child_process";
import { promisify } from "util";
import type { ExtractedErrorInfo } from "./types.js";

/**
 * Compute a SHA-256 hash fingerprint of a sensitive value for debugging
 * 
 * @param value - Sensitive value to hash
 * @returns Hex string of SHA-256 hash (first 16 characters for brevity)
 */
export function hashFingerprint(value: string): string {
  return createHash('sha256').update(value).digest('hex').substring(0, 16);
}

// Shared sanitization patterns
const SENSITIVE_PATTERNS: Array<[RegExp, string]> = [
  [/Bearer\s+[A-Za-z0-9\-._~+/]+=*/gi, "Bearer [REDACTED]"],
  [/Token\s+[A-Za-z0-9\-._~+/]+=*/gi, "Token [REDACTED]"],
  [/openl_pat_[A-Za-z0-9\-._~+/]+/gi, "openl_pat_[REDACTED]"],
  [/api[_-]?key["\s:=]+[A-Za-z0-9\-._~+/]+/gi, "api_key=[REDACTED]"],
  [/(:\/\/)[^:@]+:[^@]+@/g, "$1[REDACTED]:[REDACTED]@"],
  [/client[_-]?secret["\s:=]+[A-Za-z0-9\-._~+/]+/gi, "client_secret=[REDACTED]"],
  [/authorization[_-]?code["\s:=]+[A-Za-z0-9\-._~+/]+/gi, "authorization_code=[REDACTED]"],
  [/refresh[_-]?token["\s:=]+[A-Za-z0-9\-._~+/]+/gi, "refresh_token=[REDACTED]"],
  [/code[_-]?verifier["\s:=]+[A-Za-z0-9\-._~+/]+/gi, "code_verifier=[REDACTED]"],
];

// Sensitive keys for JSON sanitization - exact matches (fast O(1) lookup)
// Includes common variations (with underscores, hyphens, lowercase)
const SENSITIVE_KEYS = new Set([
  "password",
  "token",
  "secret",
  "apikey",
  "api_key",
  "api-key",
  "authorization",
  "auth",
  "credential",
  "pat",
  "personalaccesstoken",
  "personal_access_token",
  "personal-access-token",
  "accesstoken",
  "access_token",
  "access-token",
  "refreshtoken",
  "refresh_token",
  "refresh-token",
  "clientsecret",
  "client_secret",
  "client-secret",
]);

// Sensitive key patterns for edge cases not covered by exact matches
// These use exact word matching (^...$) to avoid false positives
// Covers camelCase, PascalCase, and other variations
const SENSITIVE_KEY_PATTERNS = [
  /^api[_-]?key$/i,                    // apiKey, api_key, api-key, ApiKey
  /^(authorization|auth)$/i,           // authorization, auth, Authorization, Auth
  /^access[_-]?token$/i,              // accessToken, access_token, access-token
  /^refresh[_-]?token$/i,             // refreshToken, refresh_token, refresh-token
  /^client[_-]?secret$/i,             // clientSecret, client_secret, client-secret
  /^personal[_-]?access[_-]?token$/i, // personalAccessToken, personal_access_token
];

/**
 * Apply sanitization patterns to a string to redact sensitive data
 *
 * @param str - String to sanitize
 * @returns Sanitized string with sensitive patterns redacted
 */
function applySanitizationPatterns(str: string): string {
  return SENSITIVE_PATTERNS.reduce((s, [pattern, replacement]) => s.replace(pattern, replacement), str);
}

/**
 * Sanitize error messages to prevent sensitive data exposure
 *
 * @param error - Error object, string, or object with message property to sanitize
 * @returns Sanitized error message
 */
export function sanitizeError(error: unknown): string {
  // Handle Error instances
  if (error instanceof Error) {
    return applySanitizationPatterns(error.message);
  }

  // Handle string values
  if (typeof error === "string") {
    return applySanitizationPatterns(error);
  }

  // Handle objects with a message property
  if (
    typeof error === "object" &&
    error !== null &&
    "message" in error &&
    typeof error.message === "string"
  ) {
    return applySanitizationPatterns(error.message);
  }

  // Fallback for unknown error types
  return "Unknown error";
}

/**
 * Sanitize JSON object to prevent sensitive data exposure in logs
 * Recursively removes or redacts sensitive fields (tokens, passwords, secrets, etc.)
 *
 * @param obj - Object to sanitize
 * @returns Sanitized object (deep clone)
 */
export function sanitizeJson(obj: unknown): unknown {
  if (obj === null || obj === undefined) {
    return obj;
  }

  if (typeof obj === "string") {
    // Apply string sanitization
    return applySanitizationPatterns(obj);
  }

  if (typeof obj !== "object") {
    return obj;
  }

  if (Array.isArray(obj)) {
    return obj.map(item => sanitizeJson(item));
  }

  // Handle objects
  const sanitized: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(obj)) {
    const lowerKey = key.toLowerCase();
    
    // First check exact match in Set (fast O(1) lookup for common cases)
    let isSensitive = SENSITIVE_KEYS.has(lowerKey);
    
    // If not found, check patterns for edge cases (camelCase, PascalCase, etc.)
    // Patterns use exact matching (^...$) to avoid false positives
    if (!isSensitive) {
      isSensitive = SENSITIVE_KEY_PATTERNS.some(pattern => pattern.test(key));
    }

    if (isSensitive) {
      sanitized[key] = "[REDACTED]";
    } else if (typeof value === "object" && value !== null) {
      // Recursively sanitize nested objects
      sanitized[key] = sanitizeJson(value);
    } else if (typeof value === "string") {
      // Sanitize string values
      sanitized[key] = sanitizeJson(value);
    } else {
      sanitized[key] = value;
    }
  }

  return sanitized;
}

/**
 * Type guard to check if an error is an Axios error
 *
 * @param error - Error to check
 * @returns True if error is an Axios error
 */
export function isAxiosError(error: unknown): error is import("axios").AxiosError {
  return (
    typeof error === "object" &&
    error !== null &&
    "isAxiosError" in error &&
    (error as { isAxiosError?: boolean }).isAxiosError === true
  );
}

/**
 * Validate timeout value
 *
 * @param timeout - Timeout value to validate
 * @param defaultTimeout - Default timeout to use if invalid
 * @returns Valid timeout value
 */
export function validateTimeout(timeout: number | undefined, defaultTimeout: number): number {
  if (timeout === undefined) {
    return defaultTimeout;
  }

  if (typeof timeout !== "number" || isNaN(timeout) || timeout <= 0) {
    return defaultTimeout;
  }

  // Cap at 10 minutes
  const MAX_TIMEOUT = 600000;
  return Math.min(timeout, MAX_TIMEOUT);
}

/**
 * Ensure OpenL API base URL points to REST endpoint.
 *
 * Adds `/rest` suffix:
 * - `http://host:8080` -> `http://host:8080/rest`
 * - `http://host:8080/studio` -> `http://host:8080/studio/rest`
 *
 * Keeps URL unchanged when path already ends with `/rest`.
 *
 * @param baseUrl - OpenL base URL from configuration
 * @returns Normalized URL with `/rest` suffix
 */
export function normalizeOpenLBaseUrl(baseUrl: string): string {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new Error(
      `Invalid OPENL_BASE_URL: "${baseUrl}". Must be a valid absolute URL (e.g., "http://localhost:8080").`
    );
  }
  const pathWithoutTrailingSlashes = url.pathname.replace(/\/+$/, "");

  if (!pathWithoutTrailingSlashes.endsWith("/rest")) {
    url.pathname = `${pathWithoutTrailingSlashes}/rest`;
  }

  return url.toString().replace(/\/$/, "");
}

/**
 * Safe JSON stringify that handles circular references
 *
 * @param obj - Object to stringify
 * @param space - Number of spaces for indentation
 * @returns JSON string
 */
export function safeStringify(obj: unknown, space?: number): string {
  const seen = new WeakSet();

  return JSON.stringify(
    obj,
    (key, value) => {
      if (typeof value === "object" && value !== null) {
        if (seen.has(value)) {
          return "[Circular]";
        }
        seen.add(value);
      }
      return value;
    },
    space
  );
}

/**
 * Extract error details for logging without exposing sensitive data
 *
 * @param error - Error to extract details from
 * @returns Safe error details object
 */
export function extractErrorDetails(error: unknown): {
  type: string;
  message: string;
  code?: string;
  status?: number;
} {
  if (isAxiosError(error)) {
    return {
      type: "AxiosError",
      message: sanitizeError(error),
      code: error.code,
      status: error.response && error.response.status,
    };
  }

  if (error instanceof Error) {
    return {
      type: error.constructor.name,
      message: sanitizeError(error),
    };
  }

  return {
    type: "Unknown",
    message: "An unknown error occurred",
  };
}

/**
 * Extract structured error information from API response data
 *
 * Handles different error response formats:
 * - 400: {code, errors[], fields[], message}
 * - 401-500: {code, message}
 * - Unknown formats: returns raw response
 *
 * @param responseData - Response data from axios error
 * @param status - HTTP status code
 * @returns Extracted error information
 */
export function extractApiErrorInfo(
  responseData: unknown,
  status?: number
): ExtractedErrorInfo {
  if (!responseData || typeof responseData !== "object") {
    return {
      rawResponse: responseData,
    };
  }

  const data = responseData as Record<string, unknown>;

  // Handle 400 Bad Request format
  if (status === 400) {
    const result: ExtractedErrorInfo = {};

    if (typeof data.code === "string") {
      result.code = data.code;
    }
    if (typeof data.message === "string") {
      result.message = data.message;
    }

    // Extract errors array if present
    if (Array.isArray(data.errors)) {
      result.errors = data.errors
        .filter((err): err is Record<string, unknown> => typeof err === "object" && err !== null)
        .map((err) => ({
          code: typeof err.code === "string" ? err.code : undefined,
          message: typeof err.message === "string" ? err.message : undefined,
        }));
    }

    // Extract fields array if present
    if (Array.isArray(data.fields)) {
      result.fields = data.fields
        .filter((field): field is Record<string, unknown> => typeof field === "object" && field !== null)
        .map((field) => ({
          code: typeof field.code === "string" ? field.code : undefined,
          field: typeof field.field === "string" ? field.field : undefined,
          message: typeof field.message === "string" ? field.message : undefined,
          rejectedValue: field.rejectedValue,
        }));
    }

    // If we extracted at least some structured data, return it
    if (result.code || result.message || result.errors || result.fields) {
      return result;
    }
  }

  // Handle 401-500 format (or any other status)
  if (status && status >= 401 && status <= 500) {
    const result: ExtractedErrorInfo = {};

    if (typeof data.code === "string") {
      result.code = data.code;
    }
    if (typeof data.message === "string") {
      result.message = data.message;
    }

    // If we extracted structured data, return it
    if (result.code || result.message) {
      return result;
    }
  }

  // Unknown format - return raw response
  return {
    rawResponse: responseData,
  };
}

/**
 * Parse project ID from OpenL API response
 *
 * Project IDs are opaque backend values in current API contracts. For legacy call sites
 * that require repository/projectName segments, this helper accepts:
 * - object format: { repository, projectName }
 * - colon string: "repository:projectName"
 *
 * @param id - Project ID from API (string or object)
 * @returns Parsed project ID with repository and projectName
 * @throws Error if the ID format is invalid
 */
export function parseProjectId(id: string | { repository: string; projectName: string }): {
  repository: string;
  projectName: string;
} {
  // Handle object format (older API versions or test mocks)
  if (typeof id === "object" && id !== null && "repository" in id && "projectName" in id) {
    return {
      repository: id.repository,
      projectName: id.projectName,
    };
  }

  // Handle string format in explicit "repository:projectName" form
  if (typeof id === "string") {
    const colonIndex = id.indexOf(":");
    if (colonIndex > 0 && colonIndex < id.length - 1) {
      const repository = id.substring(0, colonIndex);
      const projectName = id.substring(colonIndex + 1);

      if (repository && projectName) {
        return { repository, projectName };
      }
    }

    throw new Error(
      `Invalid project ID format: "${id}". Expected "repository:projectName" or object {repository, projectName}`
    );
  }

  throw new Error(
    `Invalid project ID type: ${typeof id}. Expected string or object with {repository, projectName}`
  );
}

/**
 * Create a user-friendly project ID string from repository and project name
 *
 * Format: "repository-projectName" (e.g., "design-Example 1 - Bank Rating")
 * This format is legacy and should not be used as opaque backend project IDs.
 *
 * @param repository - Repository name
 * @param projectName - Project name
 * @returns User-friendly project ID string (legacy format)
 */
export function createProjectId(repository: string, projectName: string): string {
  return `${repository}-${projectName}`;
}


/**
 * Open URL in default browser (cross-platform)
 * Works on macOS, Linux, and Windows
 *
 * @param url - URL to open
 * @returns Promise that resolves when browser is opened
 */
export async function openBrowser(url: string): Promise<void> {
  const execAsync = promisify(exec);

  const platform = process.platform;
  let command: string;

  if (platform === "darwin") {
    // macOS
    command = `open "${url}"`;
  } else if (platform === "linux") {
    // Linux - try xdg-open first, then gnome-open
    command = `xdg-open "${url}" 2>/dev/null || gnome-open "${url}" 2>/dev/null || echo "Browser not available"`;
  } else if (platform === "win32") {
    // Windows
    command = `start "" "${url}"`;
  } else {
    console.error(`[Browser] Platform ${platform} not supported for automatic browser opening`);
    return;
  }

  try {
    await execAsync(command);
    console.error(`[Browser] ✅ Opened browser with URL: ${url.substring(0, 80)}...`);
  } catch {
    // Silently fail - browser opening is optional
    console.error(`[Browser] ⚠️  Could not automatically open browser. Please open manually: ${url}`);
  }
}

