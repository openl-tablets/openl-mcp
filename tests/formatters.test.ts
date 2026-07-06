/**
 * Unit tests for formatters.ts
 * Tests response formatting and pagination functions
 */

import { describe, it, expect } from "@jest/globals";
import {
  formatResponse,
  paginateResults,
  toMarkdown,
  toMarkdownConcise,
  toMarkdownDetailed,
  formatAgentsDocument,
  AGENTS_DOCUMENT_NOTE,
} from "../src/formatters.js";
import { RESPONSE_LIMITS } from "../src/constants.js";
import type { AgentsFile } from "../src/types.js";

describe("formatters", () => {
  describe("paginateResults", () => {
    it("should paginate array with default limit and offset", () => {
      const data = Array.from({ length: 100 }, (_, i) => ({ id: i }));
      const result = paginateResults(data, 50, 0);

      expect(result.data.length).toBe(50);
      expect(result.total_count).toBe(100);
      expect(result.has_more).toBe(true);
      expect(result.next_offset).toBe(50);
    });

    it("should paginate with custom limit and offset", () => {
      const data = Array.from({ length: 100 }, (_, i) => ({ id: i }));
      const result = paginateResults(data, 20, 40);

      expect(result.data.length).toBe(20);
      expect(result.data[0]).toEqual({ id: 40 });
      expect(result.total_count).toBe(100);
      expect(result.has_more).toBe(true);
      expect(result.next_offset).toBe(60);
    });

    it("should handle last page correctly", () => {
      const data = Array.from({ length: 100 }, (_, i) => ({ id: i }));
      const result = paginateResults(data, 50, 50);

      expect(result.data.length).toBe(50);
      expect(result.total_count).toBe(100);
      expect(result.has_more).toBe(false);
      expect(result.next_offset).toBeNull();
    });

    it("should handle empty array", () => {
      const result = paginateResults([], 50, 0);

      expect(result.data.length).toBe(0);
      expect(result.total_count).toBe(0);
      expect(result.has_more).toBe(false);
      expect(result.next_offset).toBeNull();
    });

    it("should handle offset beyond data length", () => {
      const data = [{ id: 1 }, { id: 2 }];
      const result = paginateResults(data, 50, 10);

      expect(result.data.length).toBe(0);
      expect(result.total_count).toBe(2);
      expect(result.has_more).toBe(false);
      expect(result.next_offset).toBeNull();
    });

    it("should handle partial last page", () => {
      const data = Array.from({ length: 75 }, (_, i) => ({ id: i }));
      const result = paginateResults(data, 50, 50);

      expect(result.data.length).toBe(25);
      expect(result.total_count).toBe(75);
      expect(result.has_more).toBe(false);
      expect(result.next_offset).toBeNull();
    });
  });

  describe("toMarkdown", () => {
    it("should format simple object as markdown", () => {
      const data = { name: "Test", value: 123 };
      const result = toMarkdown({ data }, "test");

      expect(result).toContain("name");
      expect(result).toContain("Test");
      expect(result).toContain("value");
      expect(result).toContain("123");
    });

    it("should format array as markdown list", () => {
      const data = [
        { projectId: "design-project1", status: "OPENED" },
        { projectId: "design-project2", status: "CLOSED" },
      ];
      const result = toMarkdown({ data }, "projects");

      expect(result).toContain("project1");
      expect(result).toContain("project2");
      expect(result).toContain("OPENED");
      expect(result).toContain("CLOSED");
    });

    it("should handle empty array", () => {
      const result = toMarkdown({ data: [] }, "projects");
      expect(result).toContain("No");
    });

    it("should include pagination information when provided", () => {
      const data = [{ id: 1 }];
      const pagination = { limit: 50, offset: 0, has_more: true, next_offset: 50, total_count: 100 };
      const result = toMarkdown({ data, pagination }, "test");

      expect(result).toContain("Pagination");
      expect(result).toContain("offset");
    });
  });

  describe("toMarkdownConcise", () => {
    it("should create concise summary for projects", () => {
      const data = [
        { projectId: "design-p1", projectName: "Project1", status: "OPENED" },
        { projectId: "design-p2", projectName: "Project2", status: "CLOSED" },
      ];
      const result = toMarkdownConcise({ data }, "projects");

      expect(result).toContain("Found 2");
      expect(result.length).toBeLessThan(500); // Should be brief
    });

    it("should handle single item", () => {
      const data = [{ projectId: "design-p1", status: "OPENED" }];
      const result = toMarkdownConcise({ data }, "projects");

      expect(result).toContain("1 project");
    });

    it("should handle empty results", () => {
      const result = toMarkdownConcise({ data: [] }, "projects");
      expect(result).toContain("0");
    });

    it("should include pagination hint when has_more is true", () => {
      const data = [{ id: 1 }];
      const pagination = { limit: 50, offset: 0, has_more: true, next_offset: 50, total_count: 100 };
      const result = toMarkdownConcise({ data, pagination }, "test");

      expect(result).toContain("offset=");
    });
  });

  describe("toMarkdownDetailed", () => {
    it("should create detailed format with metadata", () => {
      const data = [
        { projectId: "design-p1", status: "OPENED" },
      ];
      const result = toMarkdownDetailed({ data }, "projects");

      expect(result).toContain("Summary");
      expect(result).toContain("Retrieved");
      expect(result.length).toBeGreaterThan(100); // Should have more content
    });

    it("should include timestamp", () => {
      const data = [{ id: 1 }];
      const result = toMarkdownDetailed({ data }, "test");

      expect(result).toMatch(/\d{4}-\d{2}-\d{2}T/); // ISO timestamp format
    });

    it("should include status breakdown for projects", () => {
      const data = [
        { projectId: "design-p1", status: "OPENED" },
        { projectId: "design-p2", status: "CLOSED" },
      ];
      const result = toMarkdownDetailed({ data }, "projects");

      expect(result).toContain("Status Breakdown");
      expect(result).toContain("opened");
      expect(result).toContain("closed");
    });
  });

  describe("formatResponse", () => {
    it("should format as JSON when format is json", () => {
      const data = { test: "value" };
      const result = formatResponse(data, "json");

      expect(() => JSON.parse(result)).not.toThrow();
      const parsed = JSON.parse(result);
      expect(parsed.data).toEqual(data);
    });

    it("should format as markdown by default", () => {
      const data = { test: "value" };
      const result = formatResponse(data, "markdown");

      expect(result).not.toMatch(/^\{/); // Should not start with JSON
      expect(result).toContain("test");
    });

    it("should format as markdown_concise", () => {
      const data = [{ projectId: "design-p1", status: "OPENED" }];
      const result = formatResponse(data, "markdown_concise", { dataType: "projects" });

      expect(result).toContain("Found");
      expect(result.length).toBeLessThan(1000);
    });

    it("should format as markdown_detailed", () => {
      const data = [{ projectId: "design-p1", status: "OPENED" }];
      const result = formatResponse(data, "markdown_detailed", { dataType: "projects" });

      expect(result).toContain("Summary");
      expect(result).toContain("Retrieved");
    });

    it("should handle pagination metadata", () => {
      const data = [{ id: 1 }];
      const result = formatResponse(data, "json", {
        pagination: { limit: 50, offset: 0, total: 100 }
      });

      const parsed = JSON.parse(result);
      expect(parsed.pagination).toBeDefined();
    });

    it("should truncate very long responses", () => {
      // Create data that will exceed 25,000 characters
      const largeArray = Array.from({ length: 1000 }, (_, i) => ({
        id: i,
        longText: "A".repeat(100),
      }));

      const result = formatResponse(largeArray, "json");

      expect(result.length).toBeLessThanOrEqual(25500); // 25000 + some buffer for truncation message
    });

    it("should include truncation message when truncated", () => {
      const largeArray = Array.from({ length: 1000 }, (_, i) => ({
        id: i,
        longText: "A".repeat(100),
      }));

      const result = formatResponse(largeArray, "json");

      // This input is far over the limit, so the array-truncation path always runs.
      expect(result).toContain("truncated");
      expect(result).toContain(RESPONSE_LIMITS.TRUNCATION_MESSAGE);
    });

    it("should handle empty data", () => {
      const result = formatResponse([], "json");
      expect(() => JSON.parse(result)).not.toThrow();
    });

    it("should handle null data", () => {
      const result = formatResponse(null, "json");
      expect(result).toContain("null");
    });

    it("should preserve data structure in JSON format", () => {
      const complexData = {
        nested: {
          array: [1, 2, 3],
          object: { key: "value" },
        },
        number: 123,
        boolean: true,
        null: null,
      };

      const result = formatResponse(complexData, "json");
      const parsed = JSON.parse(result);

      expect(parsed.data).toEqual(complexData);
    });
  });

  describe("table formatting", () => {
    it("should format tables with all metadata fields", () => {
      const tables = [
        {
          id: "test_1234",
          name: "testRule",
          tableType: "SimpleRules",
          kind: "Rules",
          signature: "double testRule(int x)",
          returnType: "double",
          file: "Rules.xlsx",
          properties: {
            category: "Test",
            version: "1.0",
          },
        },
      ];

      const result = formatResponse(tables, "markdown", { dataType: "tables" });

      expect(result).toContain("testRule");
      expect(result).toContain("Kind");
      expect(result).toContain("Signature");
      expect(result).toContain("Return Type");
      expect(result).toContain("Properties");
      expect(result).toContain("Rules");
      expect(result).toContain("double testRule");
      expect(result).toContain("category");
    });

    it("should handle tables with pipe characters in values", () => {
      const tables = [
        {
          id: "test_1234",
          name: "test|rule",
          tableType: "SimpleRules",
          kind: "Rules",
          signature: "double test(int x)",
          returnType: "double",
          file: "Rules.xlsx",
        },
      ];

      const result = formatResponse(tables, "markdown", { dataType: "tables" });

      // Should escape pipe characters
      expect(result).toContain("test\\|rule");
    });

    it("should truncate long signatures", () => {
      const longSignature = "double veryLongMethodNameWithManyParameters(int param1, int param2, int param3, int param4, int param5)";
      const tables = [
        {
          id: "test_1234",
          name: "testRule",
          tableType: "SimpleRules",
          kind: "Rules",
          signature: longSignature,
          returnType: "double",
          file: "Rules.xlsx",
        },
      ];

      const result = formatResponse(tables, "markdown", { dataType: "tables" });

      // Signature should be truncated
      expect(result).toContain("...");
      expect(result).not.toContain(longSignature);
    });

    it("should format properties correctly", () => {
      const tables = [
        {
          id: "test_1234",
          name: "testRule",
          tableType: "SimpleRules",
          kind: "Rules",
          signature: "double test()",
          returnType: "double",
          file: "Rules.xlsx",
          properties: {
            prop1: { value: 1 },
            prop2: { value: 2 },
            prop3: { value: 3 },
            prop4: { value: 4 },
          },
        },
      ];

      const result = formatResponse(tables, "markdown", { dataType: "tables" });

      // Should show first 3 properties and count
      expect(result).toContain("prop1");
      expect(result).toContain("prop2");
      expect(result).toContain("prop3");
      expect(result).toContain("+1 more");
    });
  });

  describe("test_results_summary formatting", () => {
    it("should format test results summary as markdown", () => {
      const summary = {
        executionTimeMs: 250.5,
        numberOfTests: 10,
        numberOfFailures: 2,
        numberOfPassed: 8,
      };

      const result = formatResponse(summary, "markdown", { dataType: "test_results_summary" });

      expect(result).toContain("# Test Results Summary");
      expect(result).toContain("## Summary");
      expect(result).toContain("**Total Tests**: 10");
      expect(result).toContain("**Passed**: 8");
      expect(result).toContain("**Failed**: 2");
      expect(result).toContain("**Execution Time**: 250.50 ms");
    });

    it("should handle test results summary with zero values", () => {
      const summary = {
        executionTimeMs: 0,
        numberOfTests: 0,
        numberOfFailures: 0,
        numberOfPassed: 0,
      };

      const result = formatResponse(summary, "markdown", { dataType: "test_results_summary" });

      expect(result).toContain("# Test Results Summary");
      expect(result).toContain("**Total Tests**: 0");
      expect(result).toContain("**Passed**: 0");
      expect(result).toContain("**Failed**: 0");
      expect(result).toContain("**Execution Time**: 0.00 ms");
    });

    it("should calculate numberOfPassed when not provided", () => {
      const summary = {
        executionTimeMs: 100,
        numberOfTests: 5,
        numberOfFailures: 1,
        // numberOfPassed not provided, should be calculated as numberOfTests - numberOfFailures
      };

      const result = formatResponse(summary, "markdown", { dataType: "test_results_summary" });

      expect(result).toContain("**Total Tests**: 5");
      expect(result).toContain("**Passed**: 4"); // 5 - 1 = 4
      expect(result).toContain("**Failed**: 1");
    });

    it("should handle invalid executionTimeMs gracefully", () => {
      const summary = {
        executionTimeMs: null as any,
        numberOfTests: 10,
        numberOfFailures: 2,
        numberOfPassed: 8,
      };

      const result = formatResponse(summary, "markdown", { dataType: "test_results_summary" });

      expect(result).toContain("# Test Results Summary");
      expect(result).toContain("**Execution Time**: 0.00 ms"); // Should default to 0
    });

    it("should handle invalid executionTimeMs as string", () => {
      const summary = {
        executionTimeMs: "invalid" as any,
        numberOfTests: 10,
        numberOfFailures: 2,
        numberOfPassed: 8,
      };

      const result = formatResponse(summary, "markdown", { dataType: "test_results_summary" });

      expect(result).toContain("# Test Results Summary");
      expect(result).toContain("**Execution Time**: 0.00 ms"); // Should default to 0
    });

    it("should format test results summary in JSON format", () => {
      const summary = {
        executionTimeMs: 150.25,
        numberOfTests: 20,
        numberOfFailures: 3,
        numberOfPassed: 17,
      };

      const result = formatResponse(summary, "json", { dataType: "test_results_summary" });

      const parsed = JSON.parse(result);
      expect(parsed.data).toEqual(summary);
    });
  });

  describe("edge cases", () => {
    it("should handle circular references in JSON", () => {
      const circular: any = { a: 1 };
      circular.self = circular;

      // Should not throw, should handle gracefully
      expect(() => formatResponse(circular, "json")).not.toThrow();
    });

    it("should handle unicode characters", () => {
      const data = {
        emoji: "😀🎉",
        chinese: "你好",
        arabic: "مرحبا",
      };

      const result = formatResponse(data, "json");
      const parsed = JSON.parse(result);
      expect(parsed.data).toEqual(data);
    });

    it("should handle very deep nesting", () => {
      let deep: any = { value: 1 };
      for (let i = 0; i < 50; i++) {
        deep = { nested: deep };
      }

      expect(() => formatResponse(deep, "json")).not.toThrow();
    });
  });

  describe("formatAgentsDocument", () => {
    // getProjectAgentContext returns nearest-first (project first); the document is root-first.
    const chain: AgentsFile[] = [
      { path: "foo/Project-1/AGENTS.md", content: "project guidance" },
      { path: "foo/AGENTS.md", content: "root guidance" },
    ];

    it("includes the precedence note header", () => {
      const doc = formatAgentsDocument(chain);
      // Assert against the source constant so the test auto-tracks any rewording
      // while still guarding that the precedence note actually ships.
      expect(doc).toContain(AGENTS_DOCUMENT_NOTE);
    });

    it("orders sections root-first (project folder last = highest priority)", () => {
      const doc = formatAgentsDocument(chain);
      expect(doc.indexOf("## /foo/AGENTS.md")).toBeLessThan(doc.indexOf("## /foo/Project-1/AGENTS.md"));
      expect(doc.indexOf("root guidance")).toBeLessThan(doc.indexOf("project guidance"));
    });

    it("prefixes each path with '/' and separates sections with '-----'", () => {
      const doc = formatAgentsDocument(chain);
      expect(doc).toContain("-----\n## /foo/AGENTS.md\n\nroot guidance");
      expect(doc).toContain("-----\n## /foo/Project-1/AGENTS.md\n\nproject guidance");
    });

    it("does not double-prefix a path that already starts with '/'", () => {
      const doc = formatAgentsDocument([{ path: "/abs/AGENTS.md", content: "x" }]);
      expect(doc).toContain("## /abs/AGENTS.md");
      expect(doc).not.toContain("## //abs/AGENTS.md");
    });

    it("trims trailing whitespace from content so section spacing stays uniform", () => {
      const doc = formatAgentsDocument([{ path: "a/AGENTS.md", content: "hello\n\n\n" }]);
      expect(doc).toContain("## /a/AGENTS.md\n\nhello\n");
      expect(doc).not.toContain("hello\n\n\n");
    });

    it("caps an oversized document and appends the truncation message", () => {
      const huge = formatAgentsDocument([{ path: "big/AGENTS.md", content: "x".repeat(60_000) }]);
      expect(huge.length).toBeLessThanOrEqual(RESPONSE_LIMITS.MAX_CHARACTERS + RESPONSE_LIMITS.TRUNCATION_MESSAGE.length + 2);
      expect(huge).toContain(RESPONSE_LIMITS.TRUNCATION_MESSAGE);
    });

    it("returns a short note when there are no files", () => {
      expect(formatAgentsDocument([])).toBe("No AGENTS.md files apply to this project.");
    });
  });
});
