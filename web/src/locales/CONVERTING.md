# Converting a feature folder to i18n

Brief for agents converting one feature. Full guide: `docs/contributing/i18n.md`.
Worked example: `web/src/components/features/members/` (+ `routes/$org.settings.members.tsx`).

## Scope rules

- Edit ONLY your feature folder, the route files assigned to you below, and your namespace files
  `web/src/locales/{en,ru,uz}/<ns>.json`. All namespaces are already registered in
  `locales/resources.ts` and typed; do not edit it, `lib/i18n.ts`, `common.json` or other namespaces.
- Need a shared word (Cancel, Retry, Save…)? Use `common:` keys that exist. If missing, put the
  string in your own namespace.

## Recipe

1. Read every `.tsx/.ts` in the folder; list all user-visible strings: JSX text, `aria-label`, `title`,
   `placeholder`, `alt`, toasts (`toast.*`), dialog titles/descriptions, empty states, validation
   messages, `label`/`description` fields in config arrays.
2. Add keys to `locales/en/<ns>.json` (nested objects, camelCase, by meaning: `remove.title`,
   `toast.removed`, `empty.description`). Text must be EXACTLY the current English so tests keep passing.
3. In components: `import { useTranslation } from "react-i18next";`
   `const { t } = useTranslation(["<ns>", "common"]);` then `t("remove.title", { name })`,
   `t("common:cancel")`. Cross-namespace keys need the ns in the array.
   Outside React: `import { i18n } from "@/lib/i18n"; i18n.t("<ns>:toast.saved")`.
4. Static arrays with labels: store `labelKey: "section.code"` (`as const`) and render `t(s.labelKey)`.
   Dynamic keys from data need a typed union (see `ROLE_KEY` in `members/roles.ts`).
5. No concatenation: `"Removed {{name}}."`, never `"Removed " + name`. Inline markup: `<Trans>` with
   named tags: `"Type <mono>{{value}}</mono> to confirm"` +
   `<Trans i18nKey="..." values={{ value }} components={{ mono: <span className="font-mono" /> }} />`.
6. Plurals: `t("count", { count })` with `count_one` / `count_other` in en; ru needs
   `_one _few _many _other`; uz `_one _other`. Per-state sentences: `t("x", { context: role })` →
   `x_owner`, `x_admin`.
7. Dates/numbers/sizes: use `@/lib/format` (`formatBytes`, `formatCount`, `formatDuration`,
   `formatRelative`, `formatDateTime`, `formatDate`); for other Intl use `intlLocale()` from `@/lib/i18n`.
   Never `toLocaleString()` without a locale.
8. API errors: show `errorMessage(err)` from `@/lib/error-message` instead of `err.message`.
9. Do not translate slugs, emails, URLs, code, log lines, runtime metric keys.
10. Translate into `ru/<ns>.json` and `uz/<ns>.json` (same keys, same `{{vars}}` and `<tags>`).
11. Verify: `cd web && npx tsc --noEmit && npm run lint && npx vitest run src/components/features/<folder>
    && npm run i18n:check`. Optionally add one test: `await setLanguage("ru")` then assert Russian text.

## Style

- ru: formal «вы», buttons are verbs («Сохранить»), «ё» where standard, «…» quotes for names.
- uz: Latin only; oʻ gʻ with U+02BB (ʻ), tutuq belgisi U+02BC (ʼ): `oʻchirish`, `aʼzo`. Never ASCII `'`.
- Keep names as is: Runtime, GitHub, OAuth, SSO, TOTP, URL, DNS, cron.

## Glossary

| English | Russian | Uzbek |
|---|---|---|
| App | Приложение | Ilova |
| Project | Проект | Loyiha |
| Organization | Организация | Tashkilot |
| Member / Owner / Admin | Участник / Владелец / Администратор | Aʼzo / Ega / Administrator |
| Token | Токен | Token |
| Key | Ключ | Kalit |
| Domain | Домен | Domen |
| Environment | Окружение | Muhit |
| Secret | Секрет | Maxfiy qiymat |
| Trigger | Триггер | Trigger |
| Deploy | Развернуть / развёртывание | Joylashtirish |
| Build | Сборка | Yigʻish |
| Version / Live version | Версия / Рабочая версия | Versiya / Ishlayotgan versiya |
| Logs | Логи | Loglar |
| Audit log | Журнал аудита | Audit jurnali |
| Instance / Instance admin | Инстанс / Администратор инстанса | Instans / Instans administratori |
| Runtime (platform) | Среда выполнения | Ishga tushirish muhiti |
| Invite | Приглашение | Taklif |
| Settings | Настройки | Sozlamalar |

## Assignments (folder → namespace)

| Folder / files | Namespace |
|---|---|
| `features/admin/`, `routes/admin/*.tsx`, `routes/admin.tsx` | `admin` |
| `features/app-header/` (AppTabs already done) | `app-header` |
| `features/app-settings/`, `routes/$org.apps.$app.settings.tsx` | `app-settings` |
| `routes/$org.apps.new.tsx`, `routes/$org.projects.$p.tsx`, `routes/$org.apps.$app.tsx`, `TEMPLATES` in `features/empty/no-apps.tsx` | `apps` |
| `features/audit/`, `routes/$org.settings.audit.tsx` | `audit` |
| `features/branding/` | `branding` |
| `features/domains/`, `routes/$org.apps.$app.domains.tsx` | `domains` |
| `features/editor/`, `routes/$org.apps.$app.code.tsx` | `editor` |
| `features/env/`, `routes/$org.apps.$app.env.tsx` | `env` |
| `features/invites/` (switch `ROLE_LABEL` to `t(ROLE_KEY[r])`) | `invites` |
| `features/logs/`, `routes/$org.apps.$app.logs.tsx` | `logs` |
| `features/org/`, `routes/$org.settings.general.tsx` | `org` |
| `features/overview/`, `routes/$org.apps.$app.index.tsx`, `routes/$org.index.tsx` | `overview` |
| `features/secrets/` | `secrets` |
| `features/security/`, `routes/me.security.tsx` | `security` |
| `features/tokens/`, `routes/$org.settings.tokens.tsx` | `tokens` |
| `features/triggers/`, `routes/$org.apps.$app.triggers.tsx` | `triggers` |
| `features/versions/`, `routes/$org.apps.$app.versions.tsx` | `versions` |

Done already (do not touch): `components/ui`, `components/layout`, `components/auth`, `features/empty`
(except `TEMPLATES`), `features/members`, auth routes, `routes/index.tsx`, `lib/`.
