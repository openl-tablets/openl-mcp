/**
 * Input validation utilities
 */

import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";

/**
 * Validate pagination parameters
 *
 * @param limit - Maximum items per page
 * @param offset - Starting position
 * @returns Validated pagination parameters
 * @throws McpError if parameters are invalid
 */
export function validatePagination(
  limit?: number,
  offset?: number
): { limit: number; offset: number } {
  const validatedLimit = (limit !== undefined && limit !== null) ? limit : 50;
  const validatedOffset = (offset !== undefined && offset !== null) ? offset : 0;

  if (validatedLimit < 1) {
    throw new McpError(
      ErrorCode.InvalidParams,
      `limit must be positive, got ${validatedLimit}. Set limit to a value between 1-200 (e.g., limit: 50)`
    );
  }

  if (validatedLimit > 200) {
    throw new McpError(
      ErrorCode.InvalidParams,
      `limit exceeds maximum allowed value. Got ${validatedLimit}, but limit must be <= 200. ` +
      `To retrieve more data, use pagination with offset (e.g., limit: 200, offset: 200 for next page)`
    );
  }

  if (validatedOffset < 0) {
    throw new McpError(
      ErrorCode.InvalidParams,
      `offset must be non-negative, got ${validatedOffset}. Start with offset: 0 for first page`
    );
  }

  return { limit: validatedLimit, offset: validatedOffset };
}

/**
 * Validate response format parameter
 *
 * @param format - Response format to validate
 * @returns Validated format ("json", "markdown", "markdown_concise", or "markdown_detailed")
 */
export function validateResponseFormat(
  format?: string
): "json" | "markdown" | "markdown_concise" | "markdown_detailed" {
  if (!format) {
    return "markdown"; // Default to markdown
  }

  const validFormats = ["json", "markdown", "markdown_concise", "markdown_detailed"];
  if (!validFormats.includes(format)) {
    throw new McpError(
      ErrorCode.InvalidParams,
      `response_format must be one of: ${validFormats.join(", ")}. Got "${format}". Use "markdown_concise" for brief summaries or "markdown_detailed" for full context.`
    );
  }

  return format as "json" | "markdown" | "markdown_concise" | "markdown_detailed";
}
