#!/usr/bin/env bun
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { resolve, basename, join } from "path";
import fs from "fs/promises";
import { GoogleGenAI } from "@google/genai";

// Define types for Google Generative AI response
interface GenerateContentPart {
  text: string;
}

interface GenerateContentCandidate {
  content: {
    parts: GenerateContentPart[];
  };
}

interface GenerateContentResponse {
  candidates: GenerateContentCandidate[];
}

interface GenerateContentConfig {
  temperature: number;
  maxOutputTokens: number;
}

interface GenerateContentRequest {
  model: string;
  contents: { text: string }[];
  config: GenerateContentConfig;
}

// Environment variables and constants
const CODEBASE_PATH = process.env.CODEBASE_PATH
  ? resolve(process.cwd(), process.env.CODEBASE_PATH)
  : "";
if (!CODEBASE_PATH) {
  throw new Error("CODEBASE_PATH environment variable is not set.");
}

const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY || "";
if (!GOOGLE_API_KEY) {
  throw new Error("GOOGLE_API_KEY environment variable is not set.");
}

const MODEL = process.env.MODEL || "gemini-1.5-pro";

const DEFAULT_SYSTEM_INSTRUCTION = `
Clean up the provided code like a professional software engineer, focusing on:

* Removing unused imports, variables, and redundant one line comments (retain only meaningful comment and documentation).
* Ensuring consistent naming and formatting according to language best practices.
* Simplifying minor inefficiencies (e.g., redundant calculations) *without* altering the core logic.
* Removing unnecessary whitespace while preserving single-line breaks between logical blocks of code.

Crucially, *do not* change the code's original logic, variable names (unless obviously incorrect style), or overall functionality.  Do not add any new comments except to clarify existing deprecated code. Do not rewrite or restructure major sections of code.

Output *only* the cleaned, raw code, with proper indentation and formatting.  Do not include any introductory phrases, explanations, annotations, or markdown formatting (backticks or otherwise). The output should be the code itself, ready to be copied and pasted.

Example:

**Not like this:**

\`\`\`javascript
console.log("hello");
\`\`\`

**Like this:**

console.log("hello")

---
Provide back raw code.
`;

const SYSTEM_INSTRUCTION =
  process.env.SYSTEM_INSTRUCTION || DEFAULT_SYSTEM_INSTRUCTION;

// Extend GoogleGenAI with typed method
interface ExtendedGoogleGenAI {
  models: {
    generateContent: (
      request: GenerateContentRequest
    ) => Promise<GenerateContentResponse>;
  };
}

const ai = new GoogleGenAI({ apiKey: GOOGLE_API_KEY }) as ExtendedGoogleGenAI;

const server = new McpServer({
  name: "code-cleanup",
  version: "1.0.0",
  capabilities: {
    resources: {},
    tools: {},
  },
});

async function ensureStashDirectory(): Promise<string> {
  const stashPath: string = join(CODEBASE_PATH, ".stash");
  await fs.mkdir(stashPath, { recursive: true }).catch((error: unknown) => {
    console.error("Error creating stash directory:", error);
    throw new Error("Failed to create stash directory");
  });
  return stashPath;
}

async function cleanupCode(code: string, filename: string): Promise<string> {
  try {
    const response: GenerateContentResponse = await ai.models.generateContent({
      model: MODEL,
      contents: [
        { text: "Clean up the provided code file." },
        { text: "# SYSTEM INSTRUCTION:" },
        { text: SYSTEM_INSTRUCTION },
        { text: "# FILE NAME:" },
        { text: filename },
        { text: "# CODE:" },
        { text: code },
      ],
      config: {
        temperature: 0.2,
        maxOutputTokens: 8192,
      },
    });

    if (!response.candidates?.[0]?.content?.parts?.[0]?.text) {
      throw new Error("Invalid response structure from AI");
    }

    return response.candidates[0].content.parts[0].text;
  } catch (error: unknown) {
    console.error("Error cleaning up code:", error);
    throw error;
  }
}

async function cleanupFiles(filePaths: string[]): Promise<string> {
  const stashPath: string = await ensureStashDirectory();
  const results: string[] = [];

  for (const filePath of filePaths) {
    try {
      const originalCode: string = await fs.readFile(filePath, "utf-8");
      const stashFilename: string = `${basename(filePath)}.${Date.now()}.bak`;
      const stashFilePath: string = join(stashPath, stashFilename);
      await fs.writeFile(stashFilePath, originalCode, "utf-8");
      const cleanedCode: string = await cleanupCode(
        originalCode,
        basename(filePath)
      );
      await fs.writeFile(filePath, cleanedCode, "utf-8");
      results.push(
        `${filePath} - cleaned up and backed up to .stash/${stashFilename}`
      );
    } catch (error: unknown) {
      const errorMessage: string =
        error instanceof Error ? error.message : String(error);
      results.push(`❌ ${filePath} - failed: ${errorMessage}`);
    }
  }

  return results.join("\n");
}

async function cleanupStash(): Promise<string> {
  const stashPath: string = join(CODEBASE_PATH, ".stash");

  try {
    await fs.access(stashPath).catch((): string => {
      return "No stash directory found.";
    });

    const files: string[] = await fs.readdir(stashPath);
    if (files.length === 0) {
      return "Stash directory is already empty.";
    }

    for (const file of files) {
      await fs.unlink(join(stashPath, file));
    }

    return `Cleaned up stash directory. Removed ${files.length} file(s).`;
  } catch (error: unknown) {
    const errorMessage: string =
      error instanceof Error ? error.message : String(error);
    return `Failed to clean up stash: ${errorMessage}`;
  }
}

server.tool(
  "cleanup_code_files",
  "Clean up code files and store backups in the .stash directory",
  {
    filePaths: z.array(z.string()).describe("Array of file paths to clean up"),
  },
  async ({ filePaths }: { filePaths: string[] }) => {
    const result: string = await cleanupFiles(filePaths);
    return {
      content: [{ type: "text", text: result }],
    };
  }
);

server.tool(
  "cleanup_code_stash",
  "Remove all backup files from the .stash directory",
  {},
  async () => {
    const result: string = await cleanupStash();
    return {
      content: [{ type: "text", text: result }],
    };
  }
);

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Code Cleanup MCP Server running on stdio");
  console.error(`CODEBASE_PATH: ${CODEBASE_PATH}`);
}

main().catch((error: unknown) => {
  console.error("Fatal error in main():", error);
  process.exit(1);
});
