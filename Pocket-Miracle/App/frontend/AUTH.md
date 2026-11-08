# Accounts and saved history

The app uses Supabase email/password authentication. Signed-out visitors see
the welcome/login/signup screen. Confirmation-required signups remain signed
out until the email is verified. Sessions are restored and refreshed by the
Supabase client; logging out returns to the welcome screen.

Run `npm install`, `npm run dev`, and `npm run vision` (in another terminal).
The only new frontend runtime dependency is the pinned Supabase JS client.
There are no new Python package dependencies for authentication/history.

## Supabase configuration

The existing Pocket Miracle project's public URL and publishable key are in
`src/supabase-config.json`. They are safe to include in the client: row-level
policies, not hiding that key, protect user records. Never add a service-role
or secret key to a `VITE_` variable, browser code, or this file.

In Supabase Authentication → URL Configuration, set the Site URL to the
deployed app (or `http://localhost:8443` for this laptop demo) and allow your
actual development origins as redirect URLs, including `http://localhost:8443/**`
and `http://127.0.0.1:8443/**` as appropriate. Confirmation and password-reset
links depend on this configuration. Add deployed domains explicitly before
using a hosted frontend. The signup UI reports that email verification is
required when Supabase returns no session; it never bypasses confirmation.

Supabase's default email service has delivery/rate restrictions. Configure an
appropriate SMTP service for signups outside the project's authorized test
addresses. The app does not disable email verification or send test emails
automatically. Leaked-password protection is an optional Supabase Auth setting
and remains controlled by the project configuration.

The project's current security advisor reports
[leaked-password protection disabled](https://supabase.com/docs/guides/auth/password-security#password-strength-and-leaked-password-protection).
The [no-policy RLS notice](https://supabase.com/docs/guides/database/database-linter?lint=0008_rls_enabled_no_policy)
on archived `private.app_settings` is intentional: it has no client access.
New history indexes may also show an
[unused-index notice](https://supabase.com/docs/guides/database/database-linter?lint=0005_unused_index)
until real history queries use them.

## Data isolation

- `profiles.id` refers to the account in `auth.users`.
- `app_settings.user_id` is unique; settings are no longer a global singleton.
- `detection_sessions.user_id` records who started a run, without assigning
  ownership of the physical cane.
- `detection_events` and `warnings` inherit ownership through their session.
- Authenticated clients can read/write only their own records. SQL constraints
  also prevent warnings from referencing a detection in another session.
- The signup trigger creates a profile and default settings.
- Old global settings are retained in `private.app_settings`; the older cane
  settings remain in `private.cane_settings`.

The Python service verifies bearer tokens and writes to Supabase with the
user's token, so it obeys the same RLS rules as the browser. Another account
cannot read or stop someone else's live camera run. The shared camera is
available to that account after the existing run ends.

Preferences save automatically with a short debounce. Thresholds and the
voice preference apply on the next run. Volume remains a saved preference;
the hardware volume endpoint is not implemented. Pairing, caretaker sharing,
fall detection, location, and SOS remain labeled previews/unconnected features.

## Verification

`python -m unittest test_serve -v` from `Computer Vision` tests the API,
warning logic integration, and live-camera access boundaries without hardware.
`test_cloud_live.py` is an opt-in test with disposable accounts and fake camera
input; it exercises actual Supabase Auth, persistence, and cross-user RLS.

Browser test scripts in `scripts/` use Playwright and disposable test credentials
provided via `PM_TEST_USERS_JSON`; they do not contain passwords or bypass auth.
The auth test checks real login, preference persistence after reload, history,
logout, user isolation, responsive layouts, and the confirmation-required UI
(the confirmation response is mocked so that no email is sent).
