# Domains

A custom domain lets an app answer on your own host name, such as `api.example.com`.

## Add a domain

1. Open the app's **Domains** section and enter the host name.
2. The console shows a TXT record to add at your DNS provider. The record name and value are shown exactly.
3. Add the record and choose **Verify**. Verification can take a few minutes, depending on DNS caching.
4. When the domain is verified, the router starts serving the app on that host. With HTTPS enabled on the instance, a
   certificate is issued for it.

A domain is shown as pending until its TXT record matches. A pending domain does not route traffic.

## Remove a domain

Remove the domain from the app. The router stops serving it. Remove the DNS record as well, so the name does not keep
pointing at the instance.

## Rules

- A host name can belong to one app at a time.
- Verification is repeated. If the TXT record disappears, the domain is unmapped.
