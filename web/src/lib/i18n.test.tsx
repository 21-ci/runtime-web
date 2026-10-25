import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { renderAt } from "@/test/render";

import { ApiError } from "./api";
import { errorMessage } from "./error-message";
import { formatBytes, formatDate, formatDateTime, formatDuration, formatRelative } from "./format";
import { detectLanguage, i18n, LANGUAGE_STORAGE_KEY, setLanguage } from "./i18n";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("detectLanguage", () => {
  it("prefers the saved choice over the browser", () => {
    vi.spyOn(navigator, "languages", "get").mockReturnValue(["ru-RU"]);
    localStorage.setItem(LANGUAGE_STORAGE_KEY, "uz");
    expect(detectLanguage()).toBe("uz");
  });

  it("falls back to the first supported browser language", () => {
    vi.spyOn(navigator, "languages", "get").mockReturnValue(["de-DE", "ru-RU", "en-US"]);
    expect(detectLanguage()).toBe("ru");
  });

  it("ignores an unknown saved value and unsupported browser languages", () => {
    vi.spyOn(navigator, "languages", "get").mockReturnValue(["de-DE", "fr"]);
    localStorage.setItem(LANGUAGE_STORAGE_KEY, "klingon");
    expect(detectLanguage()).toBe("en");
  });
});

describe("plurals", () => {
  it("uses the four Russian forms", async () => {
    await setLanguage("ru");
    const t = i18n.getFixedT("ru", "members");
    expect(t("count", { count: 1 })).toBe("1 участник");
    expect(t("count", { count: 2 })).toBe("2 участника");
    expect(t("count", { count: 5 })).toBe("5 участников");
    expect(t("count", { count: 21 })).toBe("21 участник");
  });

  it("uses the Uzbek one/other forms and English one/other", async () => {
    await setLanguage("uz");
    expect(i18n.getFixedT("uz", "members")("count", { count: 1 })).toBe("1 ta aʼzo");
    expect(i18n.getFixedT("uz", "members")("count", { count: 5 })).toBe("5 ta aʼzo");
    expect(i18n.getFixedT("en", "members")("count", { count: 1 })).toBe("1 member");
    expect(i18n.getFixedT("en", "members")("count", { count: 5 })).toBe("5 members");
  });
});

describe("formatting follows the language", () => {
  it("formats numbers and units in Russian", async () => {
    await setLanguage("ru");
    const now = 1_700_000_000_000;
    expect(formatBytes(1536)).toBe("1,50 КиБ");
    expect(formatDuration(2500)).toBe("2,5 с");
    expect(formatRelative(now - 5 * 60_000, now)).toBe("5 мин назад");
    expect(formatRelative(now + 2 * 3.6e6, now)).toBe("через 2 ч");
  });

  it("writes Uzbek dates as dd.MM.yyyy, which browsers lack locale data for", async () => {
    await setLanguage("uz");
    const ts = new Date(2026, 9, 5, 8, 4).getTime();
    expect(formatDate(ts)).toBe("05.10.2026");
    expect(formatDateTime(ts)).toBe("05.10.2026, 08:04");
    expect(formatRelative(ts, ts + 40 * 86_400_000)).toBe("05.10.2026");
  });
});

describe("errorMessage", () => {
  const err = new ApiError(409, "last_owner", "org must keep an owner");

  it("keeps the server message in English", () => {
    expect(errorMessage(err)).toBe("org must keep an owner");
  });

  it("translates a known code and falls back to the server message", async () => {
    await setLanguage("ru");
    expect(errorMessage(err)).toBe("В организации должен быть хотя бы один владелец.");
    expect(errorMessage(new ApiError(422, "some_runtime_code", "runtime said no"))).toBe("runtime said no");
  });
});

describe("language picker", () => {
  it("switches the sign-in page to Russian and remembers the choice", async () => {
    const user = userEvent.setup();
    renderAt("/login");
    expect(await screen.findByRole("heading", { name: "Welcome back" })).toBeInTheDocument();

    await user.selectOptions(screen.getByRole("combobox", { name: "Language" }), "ru");

    expect(await screen.findByRole("heading", { name: "С возвращением" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Войти" })).toBeInTheDocument();
    await waitFor(() => expect(document.documentElement.lang).toBe("ru"));
    expect(localStorage.getItem(LANGUAGE_STORAGE_KEY)).toBe("ru");
  });
});
