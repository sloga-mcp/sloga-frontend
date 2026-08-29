import eslint from "@eslint/js";
import prettier from "eslint-plugin-prettier/recommended";
import solid from "eslint-plugin-solid/configs/typescript";
import { defineConfig } from "eslint/config";
import tseslint from "typescript-eslint";

export default defineConfig([
  {
    ignores: [
      // minified files
      "**/i18n/catalogs/**",
      "**/i18n/locales/**",

      // build artifacts
      "**/coverage/**",
      "**/dist/**",
      "**/styled-system/**",
    ],
  },
  {
    languageOptions: {
      parserOptions: {
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  eslint.configs.recommended,
  tseslint.configs.recommended,
  solid,
  prettier,
  {
    // Build/tooling scripts run under Node, not in the browser, so the
    // browser-shaped default globals leave `console`/`process` undefined and
    // every use reads as `no-undef`. Flat config has no `/* eslint-env node */`
    // equivalent, so the environment is declared here instead.
    files: ["**/scripts/**/*.{mjs,cjs,js}", "**/*.config.{mjs,cjs,js}"],
    languageOptions: {
      globals: {
        __dirname: "readonly",
        __filename: "readonly",
        Buffer: "readonly",
        console: "readonly",
        fetch: "readonly",
        process: "readonly",
        URL: "readonly",
        URLSearchParams: "readonly",
      },
    },
  },
  {
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "warn",
        {
          caughtErrors: "all",
          varsIgnorePattern: "^_",
          argsIgnorePattern: "^_",
        },
      ],
      "solid/jsx-no-undef": ["off"],
      "prettier/prettier": ["warn"],
    },
  },
]);
