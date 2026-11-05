# Git deploys

Link an App to a repository on GitHub, GitLab or Gitea, and a push deploys it. Open the App's **Branches** page. Only
project admins can see or change the link.

## Link a repository

Give the provider, the host's public `https` address, the repository and the production branch. The console then shows
a webhook URL and a secret, once. Add both to the repository as a **push** webhook.

The address, the provider and the repository cannot be changed later. To move a link, delete it and create a new one,
which destroys the stored token and secret.

Private Git hosts are not supported: the host must be on a public address.

## The access token

The token is optional and sealed at rest. Use a fine-grained token that can read the repository. Commit statuses also
need permission to write statuses; without it a deploy still works and no status appears.

Without a token, private repositories cannot be fetched and no commit status is posted.

## What a push does

A webhook is only a hint. The console asks the provider for the branch's current head and deploys that, so replaying a
captured push cannot bring an old commit back. If the head was already deployed, nothing happens.

- A push to the production branch deploys to the App. It goes live after its build if **auto promote** is on.
- A push matching a **branch rule** deploys to that rule's App branch, which is created if needed, and goes live on the
  branch after its build. Use the **Switch** button to send it to production.
- Other branches and tags are ignored.

A failed build leaves the live version alone.

### Limitations without a token

If the provider will not tell the console the head (a private repository, or no token), the console can only refuse a
commit it has already deployed. A captured push of a commit it never deployed would still deploy. GitLab's webhook token
is a static value with no signature over the body, so anyone who learns it can send such a push. Use a token.

## Auto switch

A rule can switch the App to the branch after each build. This gives the branch's code production's secrets with no
review, so it is off by default. It never applies to a repository the provider reports as a fork, and it is skipped when
the branch has moved on since the build.

## Paused

A manual rollback, or promoting a version older than one git deployed, marks the link and its rules **Paused**, so that
the next push does not undo your decision. Builds still run, but nothing goes live on its own. Resume on the Branches
page.

## Build in CI

Repositories that need a build step can use the Action in `deploy-action/`. Upload the result somewhere the runtime can
fetch it, such as a release asset, then:

```yaml
- uses: 21-ci/runtime-web/deploy-action@<commit>
  with:
    console-url: https://console.example.com
    org: acme
    app: hello
    token: ${{ secrets.RTWEB_TOKEN }}
    archive-url: https://github.com/acme/hello/releases/download/v1/app.tar.gz
```

The token needs the `deploy` scope. The archive must be reachable without credentials or through a
signed URL; the runtime fetches it subject to the App's egress rules.
