/**
 * Tests for MCP Prompts functionality
 *
 * Ensures prompts are properly registered, loaded, and accessible via MCP protocol.
 * These tests verify that prompts will continue working as the codebase evolves.
 */

import { describe, test, expect } from "@jest/globals";
import { existsSync, readdirSync, readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import YAML from "yaml";
import {
  PROMPTS,
  loadPromptContent,
  getPromptDefinition,
  promptExists,
} from "../src/prompts-registry.js";

// ES module equivalent of __dirname
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

describe("Prompts Registry", () => {
  describe("PROMPTS array", () => {
    test("all prompt names should be unique", () => {
      const names = PROMPTS.map((p) => p.name);
      const uniqueNames = new Set(names);
      expect(uniqueNames.size).toBe(names.length);
    });

    test("all prompt names should be lowercase with underscores", () => {
      PROMPTS.forEach((prompt) => {
        expect(prompt.name).toMatch(/^[a-z_]+$/);
      });
    });
  });

  describe("Prompt definitions", () => {
    test("all expected prompts should be present", () => {
      const expectedPrompts = [
        "append_table",
        "create_rule",
        "create_rule_decision_tables",
        "create_rule_spreadsheet",
        "create_test",
        "datatype_vocabulary",
        "deploy_project",
        "dimension_properties",
        "local_projects",
        "project_agents_md",
        "project_history",
        "run_test",
        "update_test",
        "validate_after_edit",
      ];

      expectedPrompts.forEach((name) => {
        const prompt = PROMPTS.find((p) => p.name === name);
        expect(prompt).toBeDefined();
      });
    });
  });

  describe("Prompt file existence", () => {
    const promptsDir = join(__dirname, "..", "prompts");

    test("all registered prompts should have corresponding .md files", () => {
      PROMPTS.forEach((prompt) => {
        const filePath = join(promptsDir, `${prompt.name}.md`);
        expect(existsSync(filePath)).toBe(true);
      });
    });

    test("no orphaned .md files should exist", () => {
      const files = readdirSync(promptsDir).filter((f) => f.endsWith(".md"));
      const registeredNames = PROMPTS.map((p) => `${p.name}.md`);

      files.forEach((file) => {
        expect(registeredNames).toContain(file);
      });
    });
  });
});

describe("loadPromptContent", () => {
  describe("Basic loading", () => {
    test("should load create_rule prompt content", () => {
      const content = loadPromptContent("create_rule");
      expect(content).toBeDefined();
      expect(typeof content).toBe("string");
      expect(content.length).toBeGreaterThan(100);
    });

    test("should load all registered prompts without error", () => {
      PROMPTS.forEach((prompt) => {
        expect(() => loadPromptContent(prompt.name)).not.toThrow();
      });
    });

    test("should throw error for non-existent prompt", () => {
      expect(() => loadPromptContent("non_existent_prompt")).toThrow(
        /Failed to load prompt/
      );
    });
  });

  describe("Argument substitution", () => {
    test("should substitute simple variables", () => {
      const content = loadPromptContent("create_test", {
        tableName: "calculatePremium",
      });
      expect(content).toContain("calculatePremium");
      expect(content).not.toContain("{tableName}");
    });

    test("should handle missing arguments gracefully", () => {
      // Should not throw even if arguments are expected
      expect(() =>
        loadPromptContent("create_test")
      ).not.toThrow();
    });

    test("should handle extra arguments gracefully", () => {
      const content = loadPromptContent("create_rule", {
        unexpectedArg: "value",
        anotherArg: "value2",
      });
      expect(content).toBeDefined();
      expect(content.length).toBeGreaterThan(0);
    });

    test("argument names with regex metacharacters do not break substitution", () => {
      // Exercises escapeRegex(): without escaping, building a pattern like
      // `new RegExp("\\{a[b\\}")` throws "Invalid regular expression:
      // Unterminated character class".
      expect(() =>
        loadPromptContent("create_rule", { "a[b": "x", "name(1)*": "y" })
      ).not.toThrow();
    });
  });

  describe("Content consistency", () => {
    test("should return same content for repeated calls", () => {
      const content1 = loadPromptContent("create_rule");
      const content2 = loadPromptContent("create_rule");
      expect(content1).toBe(content2);
    });
  });
});

describe("Helper functions", () => {
  describe("getPromptDefinition", () => {
    test("should return definition for existing prompt", () => {
      const def = getPromptDefinition("create_rule");
      expect(def).toBeDefined();
      expect(def?.name).toBe("create_rule");
    });

    test("should return undefined for non-existent prompt", () => {
      const def = getPromptDefinition("non_existent");
      expect(def).toBeUndefined();
    });
  });

  describe("promptExists", () => {
    test("should return true for existing prompts", () => {
      expect(promptExists("create_rule")).toBe(true);
      expect(promptExists("create_test")).toBe(true);
    });

    test("should return false for non-existent prompts", () => {
      expect(promptExists("non_existent")).toBe(false);
      expect(promptExists("")).toBe(false);
    });

    test("should be case-sensitive", () => {
      expect(promptExists("create_rule")).toBe(true);
      expect(promptExists("CREATE_RULE")).toBe(false);
      expect(promptExists("Create_Rule")).toBe(false);
    });
  });

});

describe("Prompts integrity", () => {
  test("no prompt should be empty", () => {
    PROMPTS.forEach((prompt) => {
      const content = loadPromptContent(prompt.name);
      expect(content.trim().length).toBeGreaterThan(0);
    });
  });
});

describe("Frontmatter support (Approach 2)", () => {
  describe("YAML frontmatter parsing", () => {
    test("loadPromptContent should strip frontmatter from output", () => {
      PROMPTS.forEach((prompt) => {
        const content = loadPromptContent(prompt.name);

        // Content should not start with ---
        expect(content.startsWith("---")).toBe(false);

        // Should not contain frontmatter markers in the body
        expect(content.startsWith("#")).toBe(true); // Should start with markdown header
      });
    });
  });

  describe("Argument substitution with frontmatter", () => {
    // Use distinctive markers so the assertions test substitution mechanics,
    // not the surrounding prose (which is free to change).
    test("substitutes a single argument and leaves no placeholder", () => {
      const content = loadPromptContent("create_test", {
        tableName: "Zmarker_TableName",
      });

      expect(content).toContain("Zmarker_TableName");
      expect(content).not.toContain("{tableName}");
    });

    test("substitutes multiple arguments independently", () => {
      const content = loadPromptContent("create_test", {
        tableName: "Zmarker_Name",
        tableType: "Zmarker_Type",
      });

      expect(content).toContain("Zmarker_Name");
      expect(content).toContain("Zmarker_Type");
      expect(content).not.toContain("{tableName}");
      expect(content).not.toContain("{tableType}");
    });

    test("substitutes arguments in deploy_project", () => {
      const content = loadPromptContent("deploy_project", {
        projectId: "Zmarker_Project",
        environment: "Zmarker_Env",
      });

      expect(content).toContain("Zmarker_Project");
      expect(content).toContain("Zmarker_Env");
      expect(content).not.toContain("{projectId}");
      expect(content).not.toContain("{environment}");
    });

    test("removes a conditional block when its argument is absent, keeps it when present", () => {
      // Argument absent: the {if ...} block and its markers are stripped.
      const withoutArg = loadPromptContent("create_test");
      expect(withoutArg).not.toMatch(/\{if \w+\}/);
      expect(withoutArg).not.toContain("{end if}");

      // Argument present: the value (injected from inside the block) survives,
      // and no conditional markers remain.
      const withArg = loadPromptContent("create_test", {
        tableName: "Zmarker_Conditional",
      });
      expect(withArg).toContain("Zmarker_Conditional");
      expect(withArg).not.toMatch(/\{if \w+\}/);
      expect(withArg).not.toContain("{end if}");
    });
  });

  describe("Backward compatibility", () => {
    test("prompts without arguments should work unchanged", () => {
      const promptsWithoutArgs = ["create_rule", "datatype_vocabulary", "dimension_properties"];

      promptsWithoutArgs.forEach((promptName) => {
        expect(() => loadPromptContent(promptName)).not.toThrow();
        const content = loadPromptContent(promptName);
        expect(content.length).toBeGreaterThan(0);
      });
    });

    test("prompts with optional arguments should work without arguments", () => {
      const promptsWithOptionalArgs = ["create_test", "deploy_project"];

      promptsWithOptionalArgs.forEach((promptName) => {
        expect(() => loadPromptContent(promptName)).not.toThrow();
        const content = loadPromptContent(promptName);
        expect(content.length).toBeGreaterThan(0);

        // Should not have unprocessed placeholders (except in code examples)
        const placeholders = content.match(/\{if \w+\}/g);
        expect(placeholders).toBeNull(); // All should be processed
      });
    });

    test("should handle partial arguments gracefully", () => {
      // Provide only one of multiple arguments
      const content = loadPromptContent("create_test", {
        tableName: "testRule",
        // tableType omitted
      });

      expect(content).toContain("testRule");
      expect(content).not.toContain("{tableName}"); // Should be substituted
      // tableType conditional should be removed since not provided
    });
  });

});

describe("Registry and frontmatter stay in sync", () => {
  const promptsDir = join(__dirname, "..", "prompts");

  function readFrontmatter(name: string): {
    name: string;
    description?: string;
    arguments?: Array<{ name: string; description: string; required?: boolean }>;
  } {
    const raw = readFileSync(join(promptsDir, `${name}.md`), "utf-8");
    const match = raw.match(/^---\n([\s\S]*?)\n---\n/);
    if (!match) {
      throw new Error(`Prompt '${name}' has no YAML frontmatter`);
    }
    return YAML.parse(match[1]);
  }

  // Descriptions deliberately differ between the registry (served to MCP
  // clients) and the file frontmatter, so this only pins the structural
  // contract: name and argument shape. It survives prompt prose edits.
  test("frontmatter name matches the registry entry", () => {
    PROMPTS.forEach((prompt) => {
      expect(readFrontmatter(prompt.name).name).toBe(prompt.name);
    });
  });

  test("registry and frontmatter agree on whether a prompt takes arguments", () => {
    PROMPTS.forEach((prompt) => {
      const fm = readFrontmatter(prompt.name);
      const registryHasArgs = Boolean(prompt.arguments?.length);
      const frontmatterHasArgs = Boolean(fm.arguments?.length);
      expect(frontmatterHasArgs).toBe(registryHasArgs);
    });
  });

  test("registry and frontmatter declare the same argument names and required flags", () => {
    const normalize = (
      args: Array<{ name: string; required?: boolean }> = []
    ) => args.map((a) => ({ name: a.name, required: a.required ?? false }));

    PROMPTS.filter((p) => p.arguments?.length).forEach((prompt) => {
      const fm = readFrontmatter(prompt.name);
      expect(normalize(fm.arguments)).toEqual(normalize(prompt.arguments));
    });
  });
});
