# KailenFlow Suite — Information Security Policy

**Owner / security contact:** Anthony Martinez — anthonykmartinez01@gmail.com
**Applies to:** the KailenFlow Suite web app (kailenflow-suite.netlify.app), its
server functions, and any financial data received from Plaid.
**Adopted:** 24 September 2026 · **Review:** every quarter, and after any change to
how financial data is stored or accessed.

KailenFlow Suite is a private tool used by its owner. The only person whose
financial data it holds is the owner.

## 1. Access control
- The app is behind a login (Firebase Authentication, verified server-side on
  every request).
- Financial data is restricted further: the Finance functions accept only the
  owner's verified email address (`isOwner` in `netlify/shared/auth.mts`). Any
  other signed-in account is refused, even if it can use the rest of the app.
- No other users, employees or contractors have access to financial data.
- Production systems (Netlify, Plaid, Google) are reached only through the
  owner's accounts.

## 2. Authentication
- **Infrastructure:** the owner's Google account has 2-Step Verification
  enabled, and Netlify and the Plaid dashboard are signed into through that
  Google account — so every system that stores or processes financial data is
  behind multi-factor authentication.
- **The app itself:** currently signed into with email and password, without a
  second factor. Adding Google sign-in (which carries the owner's 2-Step
  Verification) is an open item (see §8).
- GitHub holds source code only, no financial data; two-factor authentication
  should still be enabled (see §8).

## 3. Secrets
- API keys and secrets (Stripe, Plaid, Google, etc.) are stored only as
  encrypted environment variables in Netlify. They are never committed to
  source control and never sent to the browser.
- Plaid access tokens are stored only in server-side storage and are never
  returned to the browser, logged, or committed.
- The bank login itself never reaches this app: the owner signs into the bank
  inside Plaid Link, and the app receives only a token.

## 4. Encryption
- **In transit:** the app is served over HTTPS only (TLS 1.2 or better), and
  every call to Plaid, Stripe and Google uses HTTPS.
- **At rest:** financial data from Plaid is stored in Netlify Blobs, which
  Netlify encrypts at rest (AES-256 or stronger).

## 5. Data minimisation
- Only what the Finance tool needs is kept: transaction date, amount,
  description, merchant, category and account id. No bank credentials, account
  numbers or balances are stored.
- Financial data is never written to source control or to the general app
  database.

## 6. Retention and deletion
- Transactions are kept while the bank connection is active, so monthly
  history can be shown.
- **Disconnect** in the Finance tool revokes the connection at Plaid
  (`/item/remove`) and deletes every stored transaction for that bank
  immediately.
- The owner can request deletion at any time by disconnecting; no copies are
  kept elsewhere.

## 7. Vulnerability management
- GitHub Dependabot vulnerability alerts and automated security fixes are
  enabled for the repository.
- Dependencies are kept minimal and reviewed when alerts appear.
- The owner keeps their computer's operating system and browser updated.
- Automated tests cover the financial calculation rules and the write guards
  on connected Google Business Profile data.

## 8. Open items
- Add multi-factor sign-in to the app (Google sign-in with 2-Step
  Verification) and require it for the Finance section.
- Enable two-factor authentication on the GitHub account.
- The source repository is public. It contains no secrets or financial data,
  but should be made private.

## 9. Incident response
If a key or token may be exposed:
1. Disconnect the bank in the Finance tool (revokes Plaid access and deletes
   stored transactions).
2. Rotate the affected secrets in Netlify and at the provider.
3. Review recent access, then reconnect once resolved.
