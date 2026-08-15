import js from "@eslint/js";
import tseslint from "typescript-eslint";
import globals from "globals";

export default tseslint.config(
  {
    ignores: [
      "dist/**",
      "node_modules/**",
      "projects/**",
      "runs/**",
      "src/templates/server/**",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["src/**/*.ts"],
    languageOptions: {
      globals: { ...globals.node },
      parserOptions: {
        project: "./tsconfig.json",
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // Unhandled rejections in an MCP server surface as a dead tool call with
      // no error, so this one is worth failing the build over.
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-explicit-any": "warn",
      "@typescript-eslint/no-unused-vars": [
        "warn",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrors: "none" },
      ],
      // ~37 hits, all redundant escapes inside regex character classes. They are
      // behaviour-preserving either way; demoted to a warning so the error gate
      // stays meaningful, to be cleaned up separately.
      "no-useless-escape": "warn",
    },
  },
  {
    // The generated server template is type-checked by tsconfig.template.json
    // against its own dependency set; linting it here would resolve imports
    // (express, dotenv) that this package does not ship.
    files: ["tests/**/*.ts", "scripts/**/*.mjs"],
    languageOptions: { globals: { ...globals.node } },
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unused-vars": "off",
    },
  }
);
