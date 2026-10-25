import "i18next";

import type { en } from "./resources";

// Keys are typed from the English JSON: a t() call with a key that en does not have fails typecheck.
declare module "i18next" {
  interface CustomTypeOptions {
    defaultNS: "common";
    resources: typeof en;
  }
}
