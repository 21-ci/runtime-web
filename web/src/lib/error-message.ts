import { ApiError } from "./api";
import { currentLanguage, i18n } from "./i18n";

// errorMessage is the text the UI shows for a failed call. The server's message is English, so in
// English it wins (it can be more specific than the code); in other languages a translated message
// for the error code wins, and the server message is the fallback for codes we do not know.
export function errorMessage(err: unknown): string {
  if (!(err instanceof ApiError)) return i18n.t("common:somethingWrong");
  const key = `errors:${err.code}`;
  const translated = i18n.exists(key) ? i18n.t(key as "errors:internal") : null;
  if (currentLanguage() === "en") return err.message || translated || i18n.t("common:somethingWrong");
  return translated || err.message || i18n.t("common:somethingWrong");
}
