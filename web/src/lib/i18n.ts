import i18n, { type BackendModule, type ResourceKey } from "i18next";
import { initReactI18next } from "react-i18next";

import { en, NAMESPACES } from "@/locales/resources";

export const LANGUAGES = [
  { code: "en", label: "English" },
  { code: "ru", label: "Русский" },
  { code: "uz", label: "Oʻzbekcha" },
] as const;

export type Language = (typeof LANGUAGES)[number]["code"];

// Intl locale per UI language. Uzbek is written in Latin script (the official one).
const INTL_LOCALE: Record<Language, string> = { en: "en", ru: "ru", uz: "uz-Latn" };

export const LANGUAGE_STORAGE_KEY = "rtweb.lang";

// Non-English locales are lazy: one chunk per locale and namespace, fetched on first use, so the
// first-route bundle only carries English.
const lazyLocales = import.meta.glob<{ default: ResourceKey }>(["../locales/ru/*.json", "../locales/uz/*.json"]);

const lazyBackend: BackendModule = {
  type: "backend",
  init() {},
  read(lng, ns, callback) {
    if (lng === "en") {
      callback(null, (en as Record<string, ResourceKey>)[ns] ?? {});
      return;
    }
    const load = lazyLocales[`../locales/${lng}/${ns}.json`];
    if (!load) {
      callback(null, {});
      return;
    }
    load().then(
      (mod) => callback(null, mod.default),
      (err: unknown) => callback(err instanceof Error ? err : new Error(String(err)), false),
    );
  },
};

export function isLanguage(value: unknown): value is Language {
  return typeof value === "string" && LANGUAGES.some((l) => l.code === value);
}

function storedLanguage(): string | null {
  try {
    return window.localStorage.getItem(LANGUAGE_STORAGE_KEY);
  } catch {
    return null;
  }
}

// detectLanguage picks the saved preference, then the first supported browser language, then English.
export function detectLanguage(): Language {
  const saved = storedLanguage();
  if (isLanguage(saved)) return saved;
  const browser = typeof navigator === "undefined" ? [] : (navigator.languages ?? [navigator.language]);
  for (const tag of browser) {
    const base = tag?.toLowerCase().split("-")[0];
    if (isLanguage(base)) return base;
  }
  return "en";
}

export function currentLanguage(): Language {
  return isLanguage(i18n.resolvedLanguage) ? i18n.resolvedLanguage : "en";
}

// intlLocale is the BCP 47 tag for Intl formatters in the current UI language.
export function intlLocale(): string {
  return INTL_LOCALE[currentLanguage()];
}

// setLanguage switches the UI language and remembers it for this browser.
export async function setLanguage(lng: Language): Promise<void> {
  try {
    window.localStorage.setItem(LANGUAGE_STORAGE_KEY, lng);
  } catch {
    // Storage blocked (private mode): the choice lasts for this page only.
  }
  await i18n.changeLanguage(lng);
}

function syncDocumentLang(lng: string) {
  if (typeof document !== "undefined") document.documentElement.lang = isLanguage(lng) ? lng : "en";
}

i18n.on("languageChanged", syncDocumentLang);

// i18nReady resolves once the detected language's namespaces are loaded. English is synchronous.
export const i18nReady = i18n
  .use(lazyBackend)
  .use(initReactI18next)
  .init({
    lng: detectLanguage(),
    fallbackLng: "en",
    supportedLngs: LANGUAGES.map((l) => l.code),
    ns: NAMESPACES,
    defaultNS: "common",
    resources: { en },
    partialBundledLanguages: true,
    initAsync: false,
    interpolation: { escapeValue: false },
    react: { useSuspense: false },
  });

export { i18n };
