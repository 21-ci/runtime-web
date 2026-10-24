# Two-factor auth and OAuth

These settings protect your own account. An instance may require some of them for everyone.

## Two-factor auth (TOTP)

1. Open your account's security page and turn on two-factor auth.
2. Scan the QR code with an authenticator app, or enter the secret by hand.
3. Enter the six-digit code from the app to confirm. Save the recovery codes the console shows.

From then on, signing in with a password also asks for a code. Recovery codes work when the authenticator is lost. If you
lose both, ask an instance admin to reset two-factor auth for your account.

## Sign in with OAuth

The sign-in page offers GitHub, Google and generic OIDC when the instance has enabled them. Pick a provider and approve
the request.

- You can sign in only to an account whose email the provider has verified, and which already exists on the instance.
  An OAuth sign-in never creates an account.
- If you see *no account*, ask an instance admin to invite your email address first.

Only instance admins can enable a provider or change its client settings.
