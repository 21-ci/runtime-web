# 21 Cloud design language

One design language for [21 Cloud Functions Runtime](https://github.com/21-ci/runtime) and Runtime Web: the console,
both docs sites, the READMEs and `llms.txt`. The console's tokens are the source of truth:
`web/src/index.css`, explained in [docs/contributing/design-tokens.md](docs/contributing/design-tokens.md). When a value
here and a token disagree, the token wins; update this file.

## Principles

Calm and neutral. Neutral surfaces, hairline dividers, one blue accent. No gradients or neon, and glass only on the console's sidebar. The logo mark is
the only gradient.

## Colour

| Role | Light | Dark |
|---|---|---|
| Canvas (`bg`) | `#FFFFFF` | `#191919` |
| Chrome, hero, code (`panel`) | `#F7F7F5` | `#202020` |
| Recessed (`panel-2`) | `#EFEFEC` | `#2A2A2A` |
| Hairline (`line`) | `rgba(0,0,0,.08)` | `rgba(255,255,255,.09)` |
| Strong hairline (`line-strong`) | `rgba(0,0,0,.16)` | `rgba(255,255,255,.16)` |
| Text (`text`) | `#1F1F1F` | `#E6E6E6` |
| Secondary text (`muted`) | `#6B6B6B` | `#A3A3A3` |
| Accent: primary action, links (`accent`) | `#2563EB` | `#5B9BFF` |
| Accent hover (`accent-hover`) | `#1D4ED8` | `#78ADFF` |
| Text on accent (`on-primary`) | `#FFFFFF` | `#0B1A33` |

Badges use the soft `tag-{hue}-bg` / `tag-{hue}-text` pairs from the tokens, never saturated fills.

## Type

Inter for text, IBM Plex Mono for code. Headings are semibold (600) with slight negative tracking. The console's base
is 14px / 1.5; the docs keep Material's reading scale. The docs load fonts through Material's Google Fonts setting,
which has no 600 cut of Inter, so docs headings render with the 700 cut.

## Radius

`4px` inline code and badges, `6px` buttons and code blocks, `10px` cards, `16px` the landing hero. `12px` is the
console's remaining step.

## Logo

The mark is `docs/assets/images/logo.svg`, with `favicon.svg` beside it; the two repositories carry identical copies.
Use it unmodified, at 72px at the top of a README and at Material's size in the docs header. Do not recolour it, and do
not put it on a coloured fill.

## Names

- **21 Cloud Functions Runtime**: the runtime, in full, in prose and titles. `rt` is the binary and `21ci` the CLI.
- **Runtime Web**: the console. `rtweb` is its App name on a node.
- **21 Cloud**: the organisation, and the logo's alt text.

## Tone

Plain, specific and factual. Say what a thing does and what it does not. No marketing adjectives. Mark what is planned
as planned.

## Docs sites

Both use Material for MkDocs with the same theme block: `primary: custom`, `accent: custom`, the three-way light, dark
and system toggle, Inter and IBM Plex Mono.

`docs/assets/stylesheets/design.css` holds the shared rules and is byte-identical in both repositories; change the two
copies together. Site-specific rules go in `extra.css`, loaded after it.

A landing page starts with `.rt-hero`: the product name or promise as `h1`, a `.rt-hero__lead` paragraph, then three
buttons, of which the first is `.md-button--primary`. Cards follow.

## READMEs

The header is the same in both: logo, centred `h1`, badges, a one-paragraph tagline, a link row, a rule.

- **Badges**, in order: CI, Security, Release, Docs, License. A repository adds badges only for a service it actually
  uses, after these.
- **Link row**: Docs, Quickstart, Features, Development, Security, Contributing.
- **Sections**, in order: Why, Features, Screenshots, Architecture, Quickstart, repository-specific sections,
  Development, Documentation, Contributing, Security, Community, License.

## llms.txt

The `h1` is the product name from [Names](#names), followed by a one-paragraph blockquote and a line with the docs site
and source URLs.
