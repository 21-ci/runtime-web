# User guide

These pages describe the console as an end user sees it. They are arranged the way most people use it: make an org,
add a project, build an app, then run it.

| Page | Covers |
|---|---|
| [Orgs](orgs.md) | Creating an org, its roles, and what an owner can do |
| [Projects](projects.md) | Projects inside an org, and environments |
| [Apps](apps.md) | Creating an app from a template, versions, settings and deletion |
| [Editor](editor.md) | Editing app code in the browser, saving, and type checking |
| [Logs](logs.md) | The live log stream and the level filter |
| [Triggers](triggers.md) | HTTP routes, schedules, and the queue with its dead-letter queue |
| [Tokens and keys](tokens.md) | The default key, custom tokens and their scopes |
| [Domains](domains.md) | Attaching a custom domain and verifying it |
| [Members](members.md) | Inviting people and giving them access to projects |
| [Two-factor auth and OAuth](two-factor-and-oauth.md) | Protecting your account, and signing in with GitHub, Google or OIDC |

Words used on these pages:

- **App**: a unit of your code, deployed to the runtime. The console says *app* everywhere.
- **Environment**: a label on an app, such as `production` or `staging`. Its name is part of the app's identity.
- **Version**: one saved build of an app's code. One version is live at a time.
