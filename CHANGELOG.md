# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/).

## [0.2.0](https://github.com/21-ci/runtime-web/compare/v0.1.0...v0.2.0) (2026-10-28)


### ⚠ BREAKING CHANGES

* **server:** serve every App at <slug>.<apps host>

### Added

* **admin:** operator node views ([aaa266c](https://github.com/21-ci/runtime-web/commit/aaa266c0c4f9d156ca08b45e34b55061a204be52))
* **api:** account security, invites and audit routes ([ab258a4](https://github.com/21-ci/runtime-web/commit/ab258a40683530617d41300f0c5b9139f7695730))
* **api:** admin and org routes ([a426707](https://github.com/21-ci/runtime-web/commit/a426707e4082fd93c45846428d9b4b953f230072))
* **api:** app routes ([24a8aa9](https://github.com/21-ci/runtime-web/commit/24a8aa9d33a0cd9de48591dfc4139fc0e8dc1749))
* **api:** server, errors, spa, setup and auth routes ([2b4cfaf](https://github.com/21-ci/runtime-web/commit/2b4cfafafe4ae57fc8ba404fcd7a2f21ff702584))
* **api:** streams, export and router endpoints ([c54334c](https://github.com/21-ci/runtime-web/commit/c54334c710622481c329dcab7533b5ec393f6d52))
* **apps:** code view, save and templates ([8c8f7a9](https://github.com/21-ci/runtime-web/commit/8c8f7a9728befb7b86083f74365f1bc616929485))
* **apps:** env, secrets, schedules and queues ([e94c093](https://github.com/21-ci/runtime-web/commit/e94c0931eb7917a3b18de39502e154bcd23c9b6f))
* **apps:** guard env writes with ETag and add PATCH for row edits ([352cf3d](https://github.com/21-ci/runtime-web/commit/352cf3dbc05de269ba92a2613568ac6ca164d590))
* **apps:** projects, app crud and slug resolution ([75a144b](https://github.com/21-ci/runtime-web/commit/75a144bef8e00d7478ecc2825fd8c49773566ea2))
* **apps:** shared log streams, stats and export ([c4337b8](https://github.com/21-ci/runtime-web/commit/c4337b8fa74219a3080edf8c5c105806ea8145e5))
* **apps:** split saving code from deploying it ([b55e31b](https://github.com/21-ci/runtime-web/commit/b55e31b32066808388941b79e9d19fec716579dc))
* **apps:** validate App slugs as DNS labels on create ([4ed6da2](https://github.com/21-ci/runtime-web/commit/4ed6da29b867e06d737b2b8bf02023ece83a08cc))
* **auth:** accept bearer tokens on the console app API ([7431325](https://github.com/21-ci/runtime-web/commit/743132502fd0c9dcef0627cef41e43ffb1fd4b07))
* **auth:** oauth/oidc login linking ([2678749](https://github.com/21-ci/runtime-web/commit/26787494ef01acefef8a9aee0e7a4e9c0e4d34c8))
* **auth:** passwords, sessions, csrf and setup token ([eaac4b8](https://github.com/21-ci/runtime-web/commit/eaac4b83139ca1b5da3b7138d8e85bb988eaca16))
* **auth:** totp 2fa, recovery codes and auth policy ([bd3ce6e](https://github.com/21-ci/runtime-web/commit/bd3ce6e88bc2f349f1ff2aaf0e6a4ddd3352c21d))
* **authz:** role and project-grant permission matrix ([c157f0d](https://github.com/21-ci/runtime-web/commit/c157f0d24da38eef7a99abaeed3968e197c93e5b))
* **branding:** render the brand into index.html and share colour tokens ([f1c0d01](https://github.com/21-ci/runtime-web/commit/f1c0d01f350bb62ed2b4a3d05d3364f437b58138))
* **config:** warn when console and Apps are same-site ([bfd3426](https://github.com/21-ci/runtime-web/commit/bfd3426d6fab3dad90cdaaf4f31bd28d002698a6))
* **crypto:** reseal legacy no-AAD values once from scheduled() ([ff60a00](https://github.com/21-ci/runtime-web/commit/ff60a0008ccce6505e03457ab2c0567f1f15e148))
* **deploy:** App subdomain site, TLS options and an unlimited plan ([23afd22](https://github.com/21-ci/runtime-web/commit/23afd225e57186e2f4d40ea48896a2d57fcf1270))
* **docker:** App subdomains, file secrets for rt and temp files on /data ([bc00f63](https://github.com/21-ci/runtime-web/commit/bc00f63dde332b1b028c1cc12e7b3203682dfa80))
* **docker:** container image with rt and the console in one process tree ([2d7b42b](https://github.com/21-ci/runtime-web/commit/2d7b42b3badb630bfbdcb9c39dc1739e2a17bef4))
* **docker:** minimal multi-arch images with the runtime and console, published to GHCR ([2c4b505](https://github.com/21-ci/runtime-web/commit/2c4b505c4063431261d7d0104dee02007c170991))
* **domains:** custom domains with dns verification ([29614ff](https://github.com/21-ci/runtime-web/commit/29614fffb1d6e60657de8f67c1031d348a2025f1))
* **editor:** confirm before leaving with unsaved code ([e11bedf](https://github.com/21-ci/runtime-web/commit/e11bedf56e35741f45a74bbbdaa02f84f53ca8d7))
* **install:** interactive installer with bare and docker modes ([6d00a91](https://github.com/21-ci/runtime-web/commit/6d00a918c38242bb08202d1ab5d717f893eb765a))
* **install:** interactive installer, per-App subdomains with Let's Encrypt, and review fixes ([6477ae1](https://github.com/21-ci/runtime-web/commit/6477ae1ca89fa444ff4476a3c21324e4014870b8))
* **install:** wildcard App certificate by default with a Cloudflare token ([d4835ef](https://github.com/21-ci/runtime-web/commit/d4835ef05ff7a8651032a1affe750f37e721d23a))
* **invites:** expiring single-use invite links ([e78b282](https://github.com/21-ci/runtime-web/commit/e78b28222e49039af87389783cb038031ca1cd54))
* keep admin usage reads out of the org activity feed ([90dd3ef](https://github.com/21-ci/runtime-web/commit/90dd3ef3459a45ee36b85ef42255f3d7e437b436))
* **keys:** members, grants, custom tokens and default key rotation ([34d4b82](https://github.com/21-ci/runtime-web/commit/34d4b8280ae963681bd35c6988647c344129e435))
* **logs:** reconnect button, client retry backoff and idle server poll backoff ([6d93ef1](https://github.com/21-ci/runtime-web/commit/6d93ef10610044d129142b5e548524601449c707))
* **members:** translate the members page ([a9ea4bf](https://github.com/21-ci/runtime-web/commit/a9ea4bf4635754b7392fcc99b6ed49a2af17c39a))
* **orgs:** admin-created orgs and users with runtime provisioning ([b8a4a19](https://github.com/21-ci/runtime-web/commit/b8a4a195e7436bcf09e4492d015dc92bd9da8b58))
* **router:** acme tls, wildcard cert and cert status ([2db340b](https://github.com/21-ci/runtime-web/commit/2db340bfeeaa269a08115251b2c7a31e2c481559))
* **router:** console and custom-domain request router ([3d88872](https://github.com/21-ci/runtime-web/commit/3d88872db11b927736b78be7d090d0b59e145ac1))
* Runtime Web v1 console on 21 Cloud Runtime ([e9d5da6](https://github.com/21-ci/runtime-web/commit/e9d5da60bc1534b38afa49badf751a1a0051bb9b))
* **runtime:** hand-written typed control-API client ([16532dd](https://github.com/21-ci/runtime-web/commit/16532dd56768bcb5ca2688c5ccc60fb230ba436d))
* **runtime:** sync to runtime v0.1.1 ([70bb288](https://github.com/21-ci/runtime-web/commit/70bb288a949b5b9bebdf6b8c64ce3bd18890f20d))
* **runtime:** time out control-API calls and map them to 504 runtime_timeout ([dccf327](https://github.com/21-ci/runtime-web/commit/dccf327549bb999f645610bc740d9f2877f363dc))
* **security:** password step for 2FA setup and linked sign-in ([4c8b361](https://github.com/21-ci/runtime-web/commit/4c8b3615cb7b1081d8021f508bc5f430ea939dd3))
* **server:** add instance branding API ([3f19658](https://github.com/21-ci/runtime-web/commit/3f19658a124aa46ab455ca3dd81162f19f947b8f))
* **server:** apps routes (CRUD+ETag, files, versions, config, queue, stats, logs SSE, export) ([9c9a9c0](https://github.com/21-ci/runtime-web/commit/9c9a9c0b152f978ecb71a683e6b94c6b01894bf6))
* **server:** apps service backs Deps.apps; app delete removes domains ([2043aa2](https://github.com/21-ci/runtime-web/commit/2043aa2c93aad71b8b59e4bc4453f366d1bebc22))
* **server:** auth API surface (sessions, guards, setup/login/me/oauth routes) ([5eb4e68](https://github.com/21-ci/runtime-web/commit/5eb4e6872cc43c7ac74c62f4329824fa3cd26920))
* **server:** configurable default plan, runtime public URL, main wiring ([801f7f1](https://github.com/21-ci/runtime-web/commit/801f7f1d88f53c6c3d2e1c9df1e55a3cfda8ae19))
* **server:** domains, audit, settings, jobs and contract guard ([d535f24](https://github.com/21-ci/runtime-web/commit/d535f242ffcaf000aae2db8d5ca237ecbe5054c1))
* **server:** foundation config, crypto, db migrations, http helpers ([97c5ac2](https://github.com/21-ci/runtime-web/commit/97c5ac29d4e7952c6f113b51d662da7c54fc0608))
* **server:** install bootstrap, embedded SPA, Caddy relay and node fragment ([ebda7bb](https://github.com/21-ci/runtime-web/commit/ebda7bbecfa999bb3dee5e231e73c997ebbc0731))
* **server:** let the App page frame the runtime's app origin ([2dd09e6](https://github.com/21-ci/runtime-web/commit/2dd09e6eb69ccacdcdfc1ad92852272124c492b5))
* **server:** one shared App slug rule (SLUG_RE) ([fe946b7](https://github.com/21-ci/runtime-web/commit/fe946b7c9d32f3d765514390fb83336b84e65426))
* **server:** org tokens, default-key rotation, projects, limits/usage, node admin ([93e8e6b](https://github.com/21-ci/runtime-web/commit/93e8e6b5305dd2c5b051078c2dc6e98f3a2e4d34))
* **server:** orgs, members, grants, users, invites and authz policy ([a0106d9](https://github.com/21-ci/runtime-web/commit/a0106d9588a8f452e4a096d384070f577865e706))
* **server:** RtCtl interface and typed runtime client ([36f9426](https://github.com/21-ci/runtime-web/commit/36f9426cba7e2e26bc35ef41d99e3de80b1ae561))
* **server:** rtctl operator SDK, chunked SDK transport and in-memory fake ([fd21b48](https://github.com/21-ci/runtime-web/commit/fd21b485ba6af76a3dfb51cb6dd40be20305db78))
* **server:** serve every App at &lt;slug&gt;.&lt;apps host&gt; ([7a61c60](https://github.com/21-ci/runtime-web/commit/7a61c6003dd0fd45a81bd898cd30852b7e61eb67))
* **server:** TypeScript backend skeleton on the 21 Cloud Runtime ([272cfde](https://github.com/21-ci/runtime-web/commit/272cfde73329e594fa83a46677109f56f191babd))
* **store:** sqlite schema, migrations and queries ([26a35c6](https://github.com/21-ci/runtime-web/commit/26a35c6d3055f6f767e55659e4c332d80a9189ce))
* **web:** add i18n foundation with lazy ru/uz locales ([6de4b5d](https://github.com/21-ci/runtime-web/commit/6de4b5d8469a2d18dd4673a1b39aabe44a6dc40a))
* **web:** admin node and instance settings ([04e2173](https://github.com/21-ci/runtime-web/commit/04e2173b8051ddeceba1ddca464842e37683c296))
* **web:** admin users, orgs and audit ([88d988c](https://github.com/21-ci/runtime-web/commit/88d988c5f97fdd6fa769d8d66601e9fb5076c136))
* **web:** api client and auth pages ([e1a4b5b](https://github.com/21-ci/runtime-web/commit/e1a4b5bac31b51717f2ada4eaab9e5b073d4847c))
* **web:** app overview and triggers ([35d2033](https://github.com/21-ci/runtime-web/commit/35d2033f264ac9f010794ac0721f8ee351620b7f))
* **web:** app runtime settings ([3ec73be](https://github.com/21-ci/runtime-web/commit/3ec73be5631b60f51b1c00f540e7377ce29f362f))
* **web:** app shell and navigation ([c214b6e](https://github.com/21-ci/runtime-web/commit/c214b6e4ab328c042913263ae9bc86ac411eca52))
* **web:** apply instance branding and add the branding editor ([8684eb9](https://github.com/21-ci/runtime-web/commit/8684eb90702f01c9a2bd9ba9d995b1a47a8aac8a))
* **web:** code editor ([e42a649](https://github.com/21-ci/runtime-web/commit/e42a6492ca6347b687ee653dde88ae70bd8476e3))
* **web:** dashboard and sidebar from trior reference ([07f4b75](https://github.com/21-ci/runtime-web/commit/07f4b7500ff560145a573fa8812f3d7839ffc60c))
* **web:** design system tokens and typography ([c090e74](https://github.com/21-ci/runtime-web/commit/c090e741dd21ffa63d225ed02aff43e5ed9f542d))
* **web:** Dokploy-style shell with a contextual app sidebar ([f2fe09b](https://github.com/21-ci/runtime-web/commit/f2fe09b1878addae67d8b732e6029828ca8dd9cb))
* **web:** env, domains, org settings and account security ([cf392e1](https://github.com/21-ci/runtime-web/commit/cf392e14132e46f5cce94e3ca29600115e2138a9))
* **web:** explain a blocked app preview instead of a broken frame ([13ff21c](https://github.com/21-ci/runtime-web/commit/13ff21c6ea2b0b2b6bdfaa92317343814fcce6c4))
* **web:** explain setup token, new-app gating and TXT mismatches ([76aed31](https://github.com/21-ci/runtime-web/commit/76aed312826cd1dcc664de9eaac805203c12e495))
* **web:** logs and versions ([2565375](https://github.com/21-ci/runtime-web/commit/2565375c1d95e29c3f9cad1a1c78b5ce504ace45))
* **web:** neutral design tokens and a quiet UI kit ([0921595](https://github.com/21-ci/runtime-web/commit/0921595c80b20b3bf09518d45f337600eccc2fce))
* **web:** render instance admin pages in the main console shell ([f00aaef](https://github.com/21-ci/runtime-web/commit/f00aaef0f811c13312694c1e403d78540bc21eab))
* **web:** restyle org, admin, account and auth pages ([39eb383](https://github.com/21-ci/runtime-web/commit/39eb383c95202447394b4d1ca0aa626ba088806c))
* **web:** rotate default key from org settings; spec drops org impersonation (instance admin acts as owner, audited) ([6dccdd8](https://github.com/21-ci/runtime-web/commit/6dccdd8b11910f51906e8ce6f0919a7b7d4ebf34))
* **web:** scaffold and design system ([7191e92](https://github.com/21-ci/runtime-web/commit/7191e9290e41096838f7ba302ceb42f0a48c4fa6))
* **web:** tidy the overview layout and version badges ([3e8bd0f](https://github.com/21-ci/runtime-web/commit/3e8bd0fba03fd2b6bc5641995a215eed3459e99b))
* **web:** translate admin (en, ru, uz) ([afdb6de](https://github.com/21-ci/runtime-web/commit/afdb6def02750e34ee552329a5630aebaa657d53))
* **web:** translate app-settings, logs, audit (en, ru, uz) ([6f4085e](https://github.com/21-ci/runtime-web/commit/6f4085ec23c04cc7cc8cd75dd4e0b8cdb41bd879))
* **web:** translate branding and editor (en, ru, uz) ([0a258cd](https://github.com/21-ci/runtime-web/commit/0a258cd63f687709838457cb63ac02736a6e36c5))
* **web:** translate overview, apps and domains (en, ru, uz) ([ca33209](https://github.com/21-ci/runtime-web/commit/ca3320986c9b6c328156db04d05dc79aa4532ac2))
* **web:** translate security, env, secrets (en, ru, uz) ([b81d59b](https://github.com/21-ci/runtime-web/commit/b81d59bc102730e21b4cf176ff2d41c40c40de77))
* **web:** translate shell, UI kit, auth pages and errors ([b7675bc](https://github.com/21-ci/runtime-web/commit/b7675bcd403d972303cb0f8766a5f79d798047e4))
* **web:** translate tokens, org, invites (en, ru, uz) ([9292b9b](https://github.com/21-ci/runtime-web/commit/9292b9be6e6e88f46d03e17efaf0cf3f8675a15e))
* **web:** translate triggers, versions (en, ru, uz) ([f1e378a](https://github.com/21-ci/runtime-web/commit/f1e378af66c5d5e27d8fcb148fb7ccc0b7bb7074))
* **web:** val.town-style App pages ([5f57479](https://github.com/21-ci/runtime-web/commit/5f57479c2e4f64e324ef89b162382acac4cc9087))
* **web:** warm colorful redesign ([153a217](https://github.com/21-ci/runtime-web/commit/153a217d3bcaab0c614d1b0114c857cf5f60018b))


### Fixed

* **admin:** audit intent and outcome rows for node mutations ([659e97a](https://github.com/21-ci/runtime-web/commit/659e97a8774a3f1e3c3c16e7044872613f12faab))
* **api:** allow data: images and inline styles in CSP ([c5f2807](https://github.com/21-ci/runtime-web/commit/c5f28075b460f8768a2d698f8edf4099e2a07267))
* **api:** app field errors, body cap, delete cleanup audit ([fc4d547](https://github.com/21-ci/runtime-web/commit/fc4d547c23b608a680e0f0d016410453a3514c5e))
* **api:** app routes gate on membership, hub close returns 503, sanitize export filename ([7b550e9](https://github.com/21-ci/runtime-web/commit/7b550e96893365fb5bebb3fa6cc4b59afb932349))
* **api:** csrf before authz, server timeouts, safe conflict messages, headers ([96f9089](https://github.com/21-ci/runtime-web/commit/96f908938a5aa41ead9cf31eb16a5fe0ba22dbae))
* **api:** settings providers, soft delete, usage range and audit actor ([3fd7a97](https://github.com/21-ci/runtime-web/commit/3fd7a97b04f937e47cda05878e1415bc889b93ee))
* **api:** validate settings before writing, single transaction ([9d712ee](https://github.com/21-ci/runtime-web/commit/9d712ee2f5419fe20eaca2469a736407982e4290))
* **apps:** build the patched env map without dynamic delete ([ceff97a](https://github.com/21-ci/runtime-web/commit/ceff97af3bd70caf958e59f9b6d5da681acb92cd))
* **apps:** count archive bytes, build_timeout 409, archive hardening ([7376b92](https://github.com/21-ci/runtime-web/commit/7376b92262bb78f29fd18426deeb6c76c0c049b3))
* **apps:** make app create and delete cleanup retryable ([c26bde8](https://github.com/21-ci/runtime-web/commit/c26bde886364d43241948b6d1b41975ce244573c))
* **apps:** partial schedule patch, secret error omits value ([83c0b7e](https://github.com/21-ci/runtime-web/commit/83c0b7e4469063eb676fa0e84d6fb8e70f27bc67))
* **apps:** purge stale project grants when a project slug is created ([f895abe](https://github.com/21-ci/runtime-web/commit/f895abe926d825ebe730a08adbef012f1099ff1d))
* **apps:** show stored source in the editor instead of a read-only bundle ([9f728d4](https://github.com/21-ci/runtime-web/commit/9f728d49b7f101806325fdc71e1caea40e2c676a))
* **apps:** std api templates, upload rollback, project grant cleanup, invalid mapping ([ed85cea](https://github.com/21-ci/runtime-web/commit/ed85cea46e4a6aa18cfe9c0a4a7f0cdbe2d9a8b8))
* **auth:** key the account login delay per network and make MFA lockout progressive ([e806332](https://github.com/21-ci/runtime-web/commit/e8063329090a68397dbbe4c25fe4c2b0ec6e86e9))
* **auth:** refuse unsafe requests whose Sec-Fetch-Site is not same-origin ([999da71](https://github.com/21-ci/runtime-web/commit/999da71a3ebe63539927de97c91893ce1233e469))
* **auth:** require https for oidc, check issuer, cache discovery ([e37d708](https://github.com/21-ci/runtime-web/commit/e37d70829e2e0c5133fbc45c00d70f5af215b053))
* **auth:** resolve OAuth issuer and endpoint hosts over DoH and reject private addresses ([a54f294](https://github.com/21-ci/runtime-web/commit/a54f294dbebb405d48814f2ee0dadc0bd5fb7c5a))
* **auth:** throttle wrong current passwords on password change ([c0f7ef3](https://github.com/21-ci/runtime-web/commit/c0f7ef309e6745f462557cb4e1257e4debb0b711))
* **authz:** owner scopes, default key scopes, explicit org-level fall-through ([64a8f21](https://github.com/21-ci/runtime-web/commit/64a8f2185d9e0b67248bd66b2bb5491a83c06b06))
* **budget:** measure the lazy TS worker separately (&lt;=1.5 MB gz); editor chunk &lt;=900 KB gz excludes it ([588aa28](https://github.com/21-ci/runtime-web/commit/588aa2898e781d5cb7b49718798ba60076ba4153))
* **ci:** split make ci from docker e2e; smoke saves code and verifies a domain via dev-only DNS override ([f3053ef](https://github.com/21-ci/runtime-web/commit/f3053efd9cc227d786a031cc9baec927d5a1e0f1))
* **config:** dev local skip, host normalization, required root token and router secret ([0073481](https://github.com/21-ci/runtime-web/commit/0073481eca8b7a72736c6f6fa1a39556f298d7ab))
* **config:** fail closed without an apps origin ([92b5250](https://github.com/21-ci/runtime-web/commit/92b52501918cdd39f0a330b4b8f169de5244e10d))
* **deploy:** give the console tenant room for normal page loads ([fdca0b8](https://github.com/21-ci/runtime-web/commit/fdca0b84c4e54cbc90d1b1985eb79e74f246a3f4))
* **docker:** build rtweb-entry without cgo and accept the rt hickory advisory ([7dfd32e](https://github.com/21-ci/runtime-web/commit/7dfd32e95de6ea0d14ccd8c0c845f3a948e85f58))
* **domains:** retry failed unmaps, activate after runtime put ([5f0f535](https://github.com/21-ci/runtime-web/commit/5f0f5354e1c5d9b2d660c1b4edb8be155115fc34))
* **editor:** keep edits typed during an in-flight save; only move the dirty baseline ([b2486bd](https://github.com/21-ci/runtime-web/commit/b2486bd0667e0c3854d838fae2b92bf36caf1fd0))
* **http:** cap JSON bodies in bytes, not UTF-16 units ([8a5c83d](https://github.com/21-ci/runtime-web/commit/8a5c83dc9095e61116919822c9a4d5cbabc367cc))
* **install:** create the housekeeping schedule with the runtime's kind/cron body ([b5eff99](https://github.com/21-ci/runtime-web/commit/b5eff99a4e28f37bb631be08b4d737d61e98e3db))
* **install:** drop the node-wide rtctl deny grant ([7ed805b](https://github.com/21-ci/runtime-web/commit/7ed805b0c16e952a83c8aea0feb63698f62b5466))
* **install:** keep rt.toml stable across reruns; test Debian 12 x86_64 ([47ea884](https://github.com/21-ci/runtime-web/commit/47ea88481db936d29962b64907d51c86e26134c9))
* **install:** make install.sh work on a real Linux host ([842f67f](https://github.com/21-ci/runtime-web/commit/842f67f26ab0d199cae4c2252d24dad87f1a0908))
* **install:** move the rtctl stable channel to the release being installed ([8436833](https://github.com/21-ci/runtime-web/commit/84368336f42f279c5079deeebef1445f884f4d0a))
* **install:** never lose a freshly issued setup token; print the real console URL ([8c7b5b3](https://github.com/21-ci/runtime-web/commit/8c7b5b390dbb46dc17a44df40e2197251603bc97))
* **install:** record per-part sha256 in the blob manifest ([0aa73ff](https://github.com/21-ci/runtime-web/commit/0aa73ffdba6d9f03d16b967eecf2a91906a06dda))
* **install:** refuse ACME e-mails at reserved domains ([0743340](https://github.com/21-ci/runtime-web/commit/074334051bfd0995b6005c8dfde4e9da2c57c6e8))
* **install:** serve Apps on their own apps host, never the console origin ([2268bde](https://github.com/21-ci/runtime-web/commit/2268bde4c9238b0a0030240fb787faf27f7a8acc))
* **invites:** existing-user accept never changes password, revoke scoped to org ([86246b6](https://github.com/21-ci/runtime-web/commit/86246b61855854e33dbeef21c55c84149bfd63e5))
* **invites:** password only for new accounts, already-member audit, concurrent accept test ([8024387](https://github.com/21-ci/runtime-web/commit/8024387edbf0a5f12118b3dbd8160a4be5cdd3df))
* **keys:** rotation compare-and-swap, grant project check, explicit marshal errors ([af62fe4](https://github.com/21-ci/runtime-web/commit/af62fe467143909882bb60b793355d78a2cb1782))
* **limits:** serve the plan's allowed_triggers and read it in the triggers page ([6beff80](https://github.com/21-ci/runtime-web/commit/6beff80d9bf155c7b22daf824040f105737f172b))
* **orgs:** tx-atomic session revoke, runtime delete failure handling ([5fbe59d](https://github.com/21-ci/runtime-web/commit/5fbe59db1282e55c75519bb8360bbbcfd1344e2c))
* **router:** normalize table hosts, poll backoff, server limits ([35532ef](https://github.com/21-ci/runtime-web/commit/35532ef64d388b0fd9d577a3e7d146fb10681c69))
* **runtime:** bound control calls (30s) and stream headers (15s), dial/TLS timeouts ([65fddd7](https://github.com/21-ci/runtime-web/commit/65fddd75996e16ba19ffaaf722ab7df2556cdce6))
* **sdk:** keep the rtctl caller guard working after the tenant id is baked in ([76501cf](https://github.com/21-ci/runtime-web/commit/76501cff73db74ca2c144fb26167565db9d0fb4f))
* **security:** bind sealed secrets to their row with AES-GCM AAD ([0f7d7b4](https://github.com/21-ci/runtime-web/commit/0f7d7b497022355692732df842038fcd5562054d))
* **security:** finish installer, deploy and CI hardening; document it ([d129f74](https://github.com/21-ci/runtime-web/commit/d129f7421c8ba7216a059e4db0f7b24eb5385263))
* **security:** flag token and default-key audit rows as_instance_admin ([30633ca](https://github.com/21-ci/runtime-web/commit/30633ca122650f56e2ca26b5e71a415431ef1eb1))
* **security:** generic host_taken on runtime conflict; document pending_limit ([88f00b7](https://github.com/21-ci/runtime-web/commit/88f00b7cdff5187ba752e60c890b626c5f45b2f3))
* **security:** loopback-only internal routes; verify asset part sha256 ([0a222ca](https://github.com/21-ci/runtime-web/commit/0a222ca22e9211aebcaf68926d80729ec0e67fdf))
* **security:** never auto-link OAuth identities by email ([e6a651e](https://github.com/21-ci/runtime-web/commit/e6a651e8197693c0e2a9a4e285fd3f5ff7817edc))
* **security:** require current password for TOTP enrollment ([0d11674](https://github.com/21-ci/runtime-web/commit/0d1167404b144054603e42ca507c6442ea94345f))
* **security:** restrict OAuth next to printable same-origin paths ([a885ecc](https://github.com/21-ci/runtime-web/commit/a885ecc0f4506e554d1c341f92d801baed9668a4))
* **security:** review findings ([b5260cb](https://github.com/21-ci/runtime-web/commit/b5260cb471b978c200a559f6799ac1a63ab86269))
* **security:** send CSP, framing, referrer and HSTS headers on all responses ([327533c](https://github.com/21-ci/runtime-web/commit/327533c7d057d7bd4f1fff5e058b904837264d15))
* **security:** test rtctl SDK allow-lists against deploy binding allow-lists ([dd2f975](https://github.com/21-ci/runtime-web/commit/dd2f975adf9e00b481b87f81c17ed430d8a3d3ca))
* **security:** throttle logins per IP, per account and globally; bound argon2 ([d5399d0](https://github.com/21-ci/runtime-web/commit/d5399d0c429f91d0280e632397b65db3e84c2812))
* **server:** answer tls-ask for App hosts with one indexed lookup ([523818f](https://github.com/21-ci/runtime-web/commit/523818ffdf959ccb59effd1b80614be937a31d5e))
* **server:** audit project create, update and delete ([9a1851f](https://github.com/21-ci/runtime-web/commit/9a1851fdcd50f69a382b4abc2d91b5c9b46e90ae))
* **server:** log the cause behind runtime_unavailable ([66b438c](https://github.com/21-ci/runtime-web/commit/66b438c386ac384bd4f53022d3d01c6d5dffc932))
* **server:** map runtime stats to the keys the overview reads ([a6ae5ac](https://github.com/21-ci/runtime-web/commit/a6ae5acc638398d26f97654deb546930c1e63a60))
* **server:** migrations tolerate a concurrent first run ([5c58416](https://github.com/21-ci/runtime-web/commit/5c584161af260ab5feeeaa6fc973bdab1d7cd796))
* **server:** record the creating user as author of a template app's first version ([71e4190](https://github.com/21-ci/runtime-web/commit/71e41908d47b80a8f43f2937272a9bc2684a0725))
* **server:** reject RTWEB_RUNTIME_PUBLIC_URL on the console origin ([247a947](https://github.com/21-ci/runtime-web/commit/247a94797da8c1e20d65ddde7043d1452ae43cfb))
* **server:** retry the first-run default org from the org list ([bd8f146](https://github.com/21-ci/runtime-web/commit/bd8f146ecee92276eb35fe64ab5256b16d534c1e))
* **server:** sniff SVG uploads without a backtracking regex ([c40f9b3](https://github.com/21-ci/runtime-web/commit/c40f9b3ad43aca7074e1f5ec6819f520683892b2))
* **web:** await code-split route loads in shell and auth tests ([b640be9](https://github.com/21-ci/runtime-web/commit/b640be9d7eab88ebdf52c6be379cc764e95c99a2))
* **web:** clear the query cache on logout, login and 401 redirect ([d8506dc](https://github.com/21-ci/runtime-web/commit/d8506dc1fcc6a8c0f39655572ad15177d6a74f7c))
* **web:** csrf bootstrap via /api/me, strict safeNext, stale reload action ([8db0b36](https://github.com/21-ci/runtime-web/commit/8db0b36fe8488a3a78770a4a3d673fd8e88d4924))
* **web:** e2e findings ([11d45cb](https://github.com/21-ci/runtime-web/commit/11d45cb45083415f0eba89e2f4d3b402ff5f158e))
* **web:** external theme init for csp ([6c129ee](https://github.com/21-ci/runtime-web/commit/6c129eebfd0962a269f3f01b15f9514e49c835c8))
* **web:** fit Russian titles, translate member roles and write Uzbek dates ([278f2cb](https://github.com/21-ci/runtime-web/commit/278f2cb65f473490cbceb20dd8b0459cababfb72))
* **web:** gate admin node and settings routes ([ee7a813](https://github.com/21-ci/runtime-web/commit/ee7a8130bd6d9ec0190b5cbba36c068f202231d2))
* **web:** keep text inside its card and give sibling cards one height ([9a7236f](https://github.com/21-ci/runtime-web/commit/9a7236fc7c7999d22fc03635287d95b47ac6044f))
* **web:** keep the editor's undo history when the language changes ([1ab6286](https://github.com/21-ci/runtime-web/commit/1ab628632cda06c41f698a9731108a493148c2fe))
* **web:** nest code editor under app tabs ([39075cd](https://github.com/21-ci/runtime-web/commit/39075cd197c923366415a7a8f157cb2369dc89cf))
* **web:** radix select, email truncation, mobile search ([95aeb8d](https://github.com/21-ci/runtime-web/commit/95aeb8dd634a523207f21bd160c57dde04bb07a5))
* **web:** send a signed-out tab to login once per burst of 401s ([36553b0](https://github.com/21-ci/runtime-web/commit/36553b03abedbfc70399dd870d88897da84b8917))
* **web:** shell error states, command menu actions and route walk ([23e9f73](https://github.com/21-ci/runtime-web/commit/23e9f735c3069ec61613932c10124444730acde6))
* **web:** show admin settings in command menu only to instance admins ([00f9f4a](https://github.com/21-ci/runtime-web/commit/00f9f4a699d679027324532a26556e814cf39a8c))
* **web:** show each logo on its own theme in the branding picker ([17c43af](https://github.com/21-ci/runtime-web/commit/17c43afb9f84291b9389ae4978e4ccf5457d8ae6))
* **web:** show only today in Usage today and keep the preview readable in dark mode ([6850b52](https://github.com/21-ci/runtime-web/commit/6850b52454f3842cb9899263b66c09aa1f2d5a24))
* **web:** toast every unhandled mutation error; hide or disable write controls by role; mount env, secrets and domains in app settings ([8adef1c](https://github.com/21-ci/runtime-web/commit/8adef1ce4af1278b3d7ed45f5cd84a0382ee2183))
* **web:** ux pass: primary actions, home redirect, auth layout, copy ([966eec5](https://github.com/21-ci/runtime-web/commit/966eec5045862b26ba6bbcb7ee9f034ccb92b60f))
* **web:** WCAG AA contrast, single dark token set, web-embed target ([dc15333](https://github.com/21-ci/runtime-web/commit/dc153339e85cde6cf2c94b5f73a8ea47133647c0))


### Documentation

* add MkDocs site for users, admins and contributors ([48936b6](https://github.com/21-ci/runtime-web/commit/48936b63274f3f6f9027b0d9b2c8dd240cd9cefd))
* add project README, policies and contributor guides ([af2d1d0](https://github.com/21-ci/runtime-web/commit/af2d1d0f12a3bcec6d6cd6d977d5bdbe4573de27))
* add project skills for UI, API endpoints and releases ([f83104f](https://github.com/21-ci/runtime-web/commit/f83104f3424fbd2875ae1eb063a57438770e06ec))
* add the branding admin guide ([4d66c1a](https://github.com/21-ci/runtime-web/commit/4d66c1a6e973704821d745e8fe07cb320fa36c1c))
* **api:** apply controller rulings ([a723726](https://github.com/21-ci/runtime-web/commit/a7237262f508d3aff3933649f983be8f71b404e6))
* **api:** review fixes ([fd36926](https://github.com/21-ci/runtime-web/commit/fd369268876bf2d7630dec50176bef2c2db343c0))
* **api:** web api contract ([e0d781c](https://github.com/21-ci/runtime-web/commit/e0d781c1fda8780e024e179225f2e81962c960cd))
* changelog for unreleased work ([9e2dc4b](https://github.com/21-ci/runtime-web/commit/9e2dc4bdf65886ab42b4f376e37180e20579d21c))
* describe the release-please flow, rulesets and PR rules ([b9ee148](https://github.com/21-ci/runtime-web/commit/b9ee148eec15cf62b7b1b76efadf660c48f8452f))
* **design:** static hosting plan, runtime task file and the 2026-10-27 review ([a686479](https://github.com/21-ci/runtime-web/commit/a686479f925d19c0d99e6d4ce008ca48412ffe65))
* **docker:** compose example and the Docker getting-started page ([c87310f](https://github.com/21-ci/runtime-web/commit/c87310fcf42b912f33a090498023eac82c7095fc))
* document the separate Apps host and its DNS record ([1cc36a2](https://github.com/21-ci/runtime-web/commit/1cc36a2a09a411f58b1d17338b321fc9cf4cc808))
* **i18n:** add the translation guide and languages page ([6949654](https://github.com/21-ci/runtime-web/commit/6949654590e25672617fe2908fa3fe7822747efd))
* installer modes, App subdomains, plans and data protection ([7550508](https://github.com/21-ci/runtime-web/commit/75505083c5e699080c7eabb6c6914fbd5b5bb2cf))
* move kept guides and update references ([974b94f](https://github.com/21-ci/runtime-web/commit/974b94fd351167ed8bc5529eca4f7ae7226c69f5))
* **ops:** restore, metrics and alerting, upgrade and downgrade ([fd36e62](https://github.com/21-ci/runtime-web/commit/fd36e62512afbf7a83916cca192f8c274e07a2b5))
* remove internal research, review and plan docs ([b22ab44](https://github.com/21-ci/runtime-web/commit/b22ab4496d1ba87b551b771a49517719771e3603))
* research, design spec, code style and v1 plan ([443ae71](https://github.com/21-ci/runtime-web/commit/443ae718aec42dfae367b78e6cee54df5ed9aaca))
* restructure the MkDocs site around install, operate and contribute tasks ([9e46288](https://github.com/21-ci/runtime-web/commit/9e462886fb368560ad3fb11a66be58d56e59ac66))
* rewrite Go-era docs for the TS backend on the runtime ([51d4c6b](https://github.com/21-ci/runtime-web/commit/51d4c6b38781218e4e587716781c4b7e94f112b9))
* rewrite the README and add SUPPORT, NOTICE and llms.txt ([dd0ddbd](https://github.com/21-ci/runtime-web/commit/dd0ddbd9b754e10e038c665680e3a701ab35490e))
* **security:** review report and fixes map ([12a6355](https://github.com/21-ci/runtime-web/commit/12a635531ecc4473d4a6eb05f431c1e802520fc3))
* ship the branding guide's screenshots with the docs ([af35594](https://github.com/21-ci/runtime-web/commit/af35594b91ff65c8b932ff47687c67da1a6f6d27))
* **skills:** describe the release-please flow in the release skill ([5994aab](https://github.com/21-ci/runtime-web/commit/5994aab344ae582c8e8900318f04873d8631c1d1))
* **ui:** update ui-design skill to the warm tokens and raise web coverage floors ([3869eb5](https://github.com/21-ci/runtime-web/commit/3869eb5a984bc13118373531512de0e042e9cab1))
* use an e-mail Let's Encrypt accepts in install examples ([55741eb](https://github.com/21-ci/runtime-web/commit/55741ebaab6fee1b7352aa6d89dd518838e3a47b))
* use the App vocabulary in the design notes ([ea0fdde](https://github.com/21-ci/runtime-web/commit/ea0fdde43907cd7eb859ce4680764a9a39418339))


### Build and packaging

* **deps:** bump e2e @playwright/test to 1.64.0 and @types/node to 26.6.5 ([dfaf869](https://github.com/21-ci/runtime-web/commit/dfaf8691f04ecec54bdf7ab6bcd79912ebe9c6fc))
* **deps:** bump server dependencies to latest supported ([41c8fd0](https://github.com/21-ci/runtime-web/commit/41c8fd0a84699dc9c11d3d3760ad00b9d85cb061))
* **deps:** bump web dependencies to latest ([be08974](https://github.com/21-ci/runtime-web/commit/be08974be437b03f654238b5bf61bbb9a08cd726))
* **docker:** run every command stage on the build platform and test rtweb-entry in the build ([d85dd71](https://github.com/21-ci/runtime-web/commit/d85dd714167581ecd4474e25e4a523b4691f2b92))
* install.sh host installer and ci-cd notes ([1d909bd](https://github.com/21-ci/runtime-web/commit/1d909bd8e1e1af6e980bd2176065ae9850846518))
* v8 coverage with thresholds and make coverage ([e9009e4](https://github.com/21-ci/runtime-web/commit/e9009e4da8e0de8abdcd8b26a132265f7c492570))

## [Unreleased]

### Added

- Interactive installer: `install.sh` asks for the mode (bare systemd service or Docker Compose), the domain, the
  console host, the apps domain, certificates and the ACME e-mail, checks DNS (including the `*.<apps domain>`
  wildcard) and ports 80/443, waits for the console and prints the URLs, the one-time setup token, the next steps and
  where data and secrets live. Everything stays scriptable with flags and `--yes`; colors only on a terminal and never
  with `NO_COLOR`.
- Docker mode in `install.sh`: the signed `ghcr.io/21-ci/runtime-web` image (pinned by digest, verified with cosign)
  with a Caddy container for Let's Encrypt, secrets as Docker secrets, `--uninstall [--purge]`. Docker is installed
  only with consent (`--install-docker`).
- `--tls auto|staging|internal|none` and `--wildcard-cert` (one `*.<apps domain>` certificate over DNS-01 with a
  Cloudflare API token, stored as a systemd credential or Docker secret, never printed; Caddy with the pinned
  Cloudflare module).
- An `unlimited` runtime plan in `deploy/rt.rtweb.toml`, the default for new orgs in both install modes.
- `docs/design/data-protection.md`: what is stored at rest, the threat model and a phased encryption plan.

- Public documentation: README, security policy, contributing guide, governance, release process, the MkDocs site
  (user, admin, security and API reference) and agent guidance in `AGENTS.md`.
- Instance branding: the console name, logos, favicon, sign-in copy, sidebar brand and help links are set from a
  Branding section in admin settings, with a light and dark live preview. Colours apply before first paint.
- Contextual app sidebar: app pages show the App's own navigation, org pages show projects, and breadcrumbs include
  the App section.
- App pages with a live preview of the running App, a usage card, and a clear message when a preview is blocked
  instead of a broken frame.
- Instance admin pages render in the main console shell, with an Instance group in the sidebar and in the command menu
  (⌘K).

### Changed

- **Breaking:** every App is served on its own subdomain, `https://<app>.<apps domain>/` (the node's
  `routing.base_domain`), and never at `/s/<app>/`: the edge (Caddy and `rtweb-entry`) answers `404` for `/s/` on the
  apps domain, for the bare apps domain and for the console's slug under it. Add a wildcard DNS record
  `*.<apps domain>`. `RTWEB_RUNTIME_PUBLIC_URL` must be an origin without a path, and the console host must not be
  under it. The App preview's `frame-src` allows `https://*.<apps domain>`.
- `tls-ask` also approves `<app>.<apps domain>` for an existing App, so each App gets its certificate on demand.
- The container passes `rt` the root token and master key as `*_FILE` paths when they come from files (the master key
  is no longer in the node's environment), creates everything with `umask 077`, and points `TMPDIR` and
  `SQLITE_TMPDIR` at `/data/tmp`: a `/tmp` tmpfs is optional now. Its default plan for new orgs is `unlimited`.
- A new bare-mode node gets its master key as a systemd credential (`LoadCredential`), not an environment variable.

- Neutral design tokens and a quieter UI kit: white canvas, off-white chrome, a single blue accent, a new dark theme
  of three neutral grey steps, and 6px or 10px radii on buttons, inputs, cards and dialogs.
- Cards keep their text inside the card, and sibling cards in a row share one height.
- **Breaking:** Apps are served from their own apps host (`apps.<domain>` by default, set with `--apps-domain` in
  `install.sh`). The DNS zone needs an apps record before upgrading. The server refuses to serve Apps from the console
  origin, and refuses a `RTWEB_RUNTIME_PUBLIC_URL` that matches it.
- The App preview frame is allowed by the Content Security Policy (`frame-src`) when the apps host is set. It stays
  `'none'` otherwise.
- Usage shows only today's counters, in UTC, instead of one row per day the runtime returned.
- Console tenant plan limits raised to 300 requests per second and 64 concurrent requests, with no daily cap, so normal
  page loads no longer hit `rate_limited`.
- Project creation, update and deletion, and queue sends, are written to the org audit log.
- Documentation restructured around install, operate and contribute tasks, with the README, `SUPPORT`, `NOTICE` and
  `llms.txt` rewritten.

### Deprecated

- The fallback that opens sealed values stored without a seal context (no AAD) will be removed in the next release.
  A one-time `scheduled()` job now reseals every such value (org default keys, TOTP secrets, OAuth client secrets)
  and records `crypto.legacy_resealed` in settings; upgrade through this release before the next one.

### Fixed

- A signed-out tab is sent to the login page once per burst of 401 responses instead of looping.
- Trigger pages honour the plan's allowed trigger types, so cron is disabled where the plan forbids it.
- The overview shows runtime request and latency stats (the runtime's stats keys are mapped correctly).
- The creating user is recorded as the author of a template App's first version.
- The first-run default org is created from the org list if setup could not create it while the runtime was not ready.
- Token and default-key audit rows are flagged as instance-admin actions.
- The App editor shows the stored source instead of a read-only bundle.
- The installer grants rtctl access correctly on a fresh node, and the console URL printed at the end is the real one.
- Usage preview stays readable in dark mode.

### Security

- Login is throttled per IP, per account and globally. The client IP comes only from the runtime. Argon2 runs are capped,
  and new password hashes use stronger parameters with old hashes rehashed on sign-in.
- OAuth never links an identity to an existing account by matching email. Linking requires a signed-in session. OAuth
  `next` targets are limited to printable same-origin paths.
- Sealed secrets (default keys, TOTP secrets and OAuth client secrets) are bound to their row with AES-GCM
  additional authenticated data.
- TOTP enrollment requires the current password.
- Internal routes accept only loopback callers.
- All responses send a Content Security Policy, framing, referrer and HSTS headers.
- The installer records and verifies a SHA-256 for each part of the release blob.

## [0.1.0] - TBD

First release of the Runtime Web console on top of 21 Cloud Runtime.

### Added

- Users, instance setup and first-run admin account, password policy, and session login with CSRF and Origin checks.
- Two-factor authentication (TOTP) and GitHub, Google and generic OIDC sign-in, with optional enforcement per instance.
- Orgs, projects, members with owner, admin and member roles, per-project roles (admin, developer and viewer), and invites.
- Apps: creation from templates, code editor with type checking, versions and rollback, settings for limits, scaling,
  ingress and egress, and access rules.
- Triggers: HTTP routes, interval and cron schedules, and the durable queue with a dead-letter queue.
- Environment variables and write-only secrets, sealed at rest.
- Scoped API tokens and default org keys, shown once on creation.
- Custom domains with DNS TXT verification and router-managed TLS.
- Live log stream over Server-Sent Events, and per-app usage stats.
- Org audit log and an instance admin console (users, orgs, runtime node, cache, settings, domains, audit).

[Unreleased]: https://github.com/21-ci/runtime-web/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/21-ci/runtime-web/releases/tag/v0.1.0
