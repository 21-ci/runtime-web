import js from "@eslint/js";
import { defineConfig } from "eslint/config";
import tseslint from "typescript-eslint";

export default defineConfig(
  { ignores: ["node_modules", "src/gen/**"] },
  js.configs.recommended,
  tseslint.configs.strict,
  {
    files: ["scripts/**/*.mjs"],
    languageOptions: { globals: { process: "readonly", console: "readonly", fetch: "readonly", URL: "readonly", setTimeout: "readonly" } },
  },
);
