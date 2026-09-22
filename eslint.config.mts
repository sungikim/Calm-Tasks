import obsidianmd from "eslint-plugin-obsidianmd";
import globals from "globals";
import { defineConfig, globalIgnores } from "eslint/config";

export default defineConfig(
  globalIgnores([
    "node_modules",
    "docs",
    "release",
    "main.js",
    "esbuild.mjs",
    "version-bump.mjs",
    "versions.json",
    "package.json",
    "package-lock.json",
    "tsconfig.json"
  ]),
  {
    languageOptions: {
      globals: { ...globals.browser },
      parserOptions: {
        projectService: {
          allowDefaultProject: ["eslint.config.mts", "manifest.json"]
        },
        tsconfigRootDir: import.meta.dirname,
        extraFileExtensions: [".json"]
      }
    }
  },
  ...obsidianmd.configs.recommended,
  {
    rules: {
      "obsidianmd/ui/sentence-case": ["warn", {
        brands: ["Calm Tasks", "Buy Me a Coffee", "Markdown", "Microsoft", "Microsoft To Do", "Microsoft Entra", "Obsidian", "MS-ToDo", "10 🙂 Life/93 ✉️ Daily note", "Tasks.ReadWrite"],
        acronyms: ["YYYY-MM-DD", "ID", "URL", "API"],
        enforceCamelCaseLower: true
      }]
    }
  }
);
