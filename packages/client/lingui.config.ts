import extractor from "@lingui-solid/babel-plugin-extract-messages/extractor";
import { defineConfig } from "@lingui/cli";
import { LinguiConfig } from "@lingui/conf";

import { Languages } from "./components/i18n/Languages";

/* eslint-disable */
const supressWarningIfWereNotInLinguiExtract = !(
  process as any
)?.argv[1]?.includes("lingui-extract.js");
/* eslint-enable */

export default defineConfig({
  sourceLocale: "en",
  compileNamespace: "ts",
  locales: Object.values(Languages).map(({ i18n }) => i18n),
  catalogs: [
    {
      path: "<rootDir>/components/i18n/catalogs/{locale}/messages",
      include: ["src", "components"],
      exclude: ["**/node_modules/**", "**/i18n/locales/**"],
    },
  ],
  runtimeConfigModule: {
    Trans: ["@lingui-solid/solid", "Trans"],
    useLingui: ["@lingui-solid/solid", "useLingui"],
    extractors: [extractor],
  },
  formatOptions: {
    origins: true,
    lineNumbers: false,
  },
  ...(supressWarningIfWereNotInLinguiExtract
    ? {}
    : {
        macro: {
          // 🔴 `corePackage` REPLACES lingui's default `["@lingui/core/macro"]`
          // rather than adding to it, so listing only the solid package made
          // `t` from `@lingui/core/macro` invisible to `lingui extract` — while
          // still COMPILING AND RENDERING, because the vite build transforms it
          // through `vite-plugin-babel-macros`, which never reads this block.
          // A macro that silently fails to extract is worse than a plain
          // string: it looks correct, but its msgid reaches no catalog, so the
          // UI renders the English source in every locale forever.
          //
          // Keeping the default entry alongside the solid one is what lets
          // non-component code — plain classes like `Voice`, where the
          // `useLingui()` hook cannot be called — localize at all. Verified by
          // a control-pair extract on 2026-08-29: adding this entry adds
          // exactly one msgid (`New name`, from `EditCategory.tsx`, the repo's
          // only pre-existing usage) and removes none.
          corePackage: ["@lingui-solid/solid", "@lingui/core/macro"],
          jsxPackage: ["@lingui-solid/solid/macro"],
        },
      }),
} as LinguiConfig);
