# Code style — Runtime Web

Every implementer must read this. It is binding for `server/` and `web/`.

## Server (`server/`)
- TypeScript, **strict** (`noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `verbatimModuleSyntax`), ESM
  with explicit `.ts` import paths. The service runs on 21 Cloud Runtime (Deno runtime); tests run on Node 22.5+.
- `src/main.ts` is the only file that touches runtime globals (`Deno.env`, `std:*` adapters, `sdk("rtctl")`).
  `src/app.ts` is the runtime-agnostic composition root: each feature adds one `registerX(router, deps)` line,
  `registerAuth` first and `registerSpa` last. Everything else receives what it needs through `Deps`.
- Routes live in `src/routes/<area>.ts`; feature logic in `src/<feature>/`. HTTP routing is the small router in
  `src/http/router.ts`; no framework.
- Errors: throw the helpers in `src/http/errors.ts` (`notFound()`, `conflict(code)`, `invalid(fields)`, `AppError`).
  The router maps them to `{"error":{"code","message","details?"}}` with snake_case codes. Runtime failures map in
  one place, `src/runtime/errors.ts`.
- Authorization goes through `can()` in `src/authz/policy.ts`, applied per request by `orgAccess` / `authorize`
  in `src/orgs/members.ts`. Never check a role inline in a handler.
- Config comes from env vars and service secrets (`RTWEB_*`), validated fail-closed in `src/config.ts`.
- Storage: `std:sql` through the `Storage` interface (`src/storage/types.ts`); plain SQL, no ORM. Migrations in
  `src/db/schema.ts` are append-only and idempotent, valid on both the runtime SQLite and `node:sqlite`.
- The one control-API path is the `rtctl` SDK (`sdk/rtctl/mod.ts`) behind `src/runtime/client.ts`. State-changing
  routes record an audit entry through `src/audit/`.
- Dependencies: avoid them. The bundle's npm imports are listed in `rt.json` (`imports`); today only `hash-wasm`.
- Tests: Vitest. The `unit` project runs the whole app through `testApp()` (`test/harness.ts`: node:sqlite in
  memory, a Map for KV, fake clock, `FakeRtCtl` in `test/fakes/`). The `integration` project needs a live node
  (`RT_INVOKE`) and skips itself without one. Every documented route gets at least one success and one error test.
- Lint with ESLint flat config (`eslint.config.mjs`, typescript-eslint); typecheck with `tsc --noEmit`. No
  Prettier.

## Frontend (`web/`)
- **npm** (package-lock.json). Vite + React 19 + TS strict + Tailwind v4 (`@tailwindcss/vite`).
- Use shadcn-style primitives in `src/components/ui/` (lowercase files: `button.tsx`), built on Radix +
  `cva` + `clsx` + `tailwind-merge` (`cn()` in `src/lib/utils.ts`). Icons come from `lucide-react` and toasts
  from `sonner`. Theme uses CSS variables on `:root` plus a `.dark` class.
- Folders: `src/routes/` (TanStack Router file routes), `src/components/{ui,layout,features/<feature>}`,
  `src/lib/` (api client, utils), `src/hooks/`.
- Data goes through TanStack Query hooks only (`useApps(org)`), never `fetch` in components. The API client in
  `src/lib/api.ts` sends `credentials: "include"` and `X-CSRF-Token`.
- Lint uses an ESLint flat config (`eslint.config.mjs`, typescript-eslint + react-hooks); there is no Prettier.
- Tests: Vitest + Testing Library for components and hooks (MSW for the API). Playwright e2e lives in `e2e/`.

## Repo
- Commits follow Conventional Commits with a scope: `feat(auth): …`, `fix(domains): …`, `test(authz): …`,
  `docs(api): …`.
- `.env.example` has a header, numbered sections and `dev-insecure-*` placeholders.
- Shell (`install.sh`, `scripts/*.sh`) is POSIX `sh` where it runs on hosts, clean under `shellcheck`. Workflows
  pin every action by commit SHA and pass `actionlint`.
- `CLAUDE.md` has a module map table (Dir | Responsibility) plus build/test commands.
- The UI says **App**, never "val". The runtime's word "service" appears only in `server/src/runtime/`, `sdk/` and deploy
  scripts.
