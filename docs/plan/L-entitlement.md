# L — Tenant entitlement & admission

> **Status: IMPLEMENTED.** All three phases shipped — `status` lifecycle
> (active/pending/suspended) + suspend/reactivate/delete, invites, hashed join
> codes, and the `ACCESS_POLICY` admission resolver. Replaces "email-domain
> provenance admits you" with a ctxlayer-owned membership model. Decoupled from
> — and shipped before — the centralized `auth.ctxlayer.net` broker (see
> [K-multitenancy.md](K-multitenancy.md)). This doc is reference for the
> *intent*; trust the code (`auth/admission.ts`, `db/migrations/0019`, the
> Admin · Users/Invites/Join-codes pages) for the exact behaviour — a couple of
> details landed differently than sketched below (notably `request` opens to
> anyone when no org/domain boundary is set; see §6).

## 1. Principle

**Federate authentication, keep authorization local.** The IdP (GitHub /
Google / future Entra-as-sign-in) only proves *"this person controls
`name@visma.com`."* Whether that identity may enter *this* tenant is decided
entirely by ctxlayer's own per-tenant store — never by a claim the customer's
IdP emits.

Why: `visma.com` is one email domain shared across many Visma business
entities, each its own tenant. Domain/org provenance proves "is a Visma
employee," not "belongs to this entity." And anything that leans on the
customer's Entra/Workspace config (app roles, group claims, `tid`) is bespoke
per company — every onboarding becomes an integration project. The boundary
must be a secret/record **ctxlayer controls** and the entity's own admin
distributes.

## 2. Current state (what to change)

| Concern | Today | File |
| --- | --- | --- |
| Gate | env allowlist at IdP callback (`ALLOWED_GITHUB_ORG/USERS`, `ALLOWED_GOOGLE_HD/EMAILS`) | `apps/worker/src/util/allowlist.ts` |
| On pass | `upsertUser` auto-creates a full `user` — no pending/approval state | `apps/worker/src/db/queries/users.ts:34` |
| Membership | `users` keyed by `(idp, idp_sub)`, has `role` but **no status column** | `apps/worker/src/db/migrations/0001_init.sql` |
| Callback wiring | `enforce*Allowlist` → throw → `signInErrorRedirect`; else `upsertUser` + session | `idp/github.ts:124-161`, `idp/google.ts:114-148` |
| Suspension | none — a row, once created, can always sign in | — |

The env allowlist is currently **both** the pre-filter and the admission
decision. We split those: the allowlist becomes an optional *coarse
pre-filter*; admission becomes a separate, explicit decision.

## 3. Target model

Layered. The tenant admin picks the policy; mechanisms stack:

| Mechanism | Boundary controlled by | Scales to | Result on match |
| --- | --- | --- | --- |
| **Invite** (single + bulk/CSV) | admin enumerates emails | tens | `active` |
| **Join code / link** (per tenant) | the entity admin distributes the code | hundreds, hands-off | `active` or `pending` (per code) |
| **Pending-approval queue** | admin clicks approve / deny | any | `active` after approval |
| Domain/org pre-filter | env config | — | **necessary-but-not-sufficient**; never admits alone |

Sweet spot for a Visma entity: **domain-restricted join code + pending
approval** — each entity tenant has its own code, the entity admin shares it
in their own channel, ctxlayer never has to understand their IdP.

## 4. Data model — migration `0019_entitlement.sql`

Respect the D1/SQLite rules in [G-conventions.md](G-conventions.md) §G1:
every enum column gets a `CHECK`; no expressions in `PRIMARY KEY`; do **not**
rebuild `users` (it is a referenced parent — `team_members`,
`user_credentials`, `user_roles`, `git_sources.created_by` all FK it). Use
`ALTER TABLE ADD COLUMN` for the status field; new child tables for the rest.

```sql
-- 1. Membership status on the existing users table.
--    DEFAULT 'active' backfills every existing row → zero behaviour change.
ALTER TABLE users ADD COLUMN status TEXT NOT NULL DEFAULT 'active'
  CHECK (status IN ('active', 'pending', 'suspended'));

-- 2. Pre-authorised emails (the "invite" mechanism).
CREATE TABLE invites (
  id            TEXT PRIMARY KEY,
  email         TEXT NOT NULL,            -- normalised lowercase
  invited_by    TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at    INTEGER NOT NULL,
  redeemed_at   INTEGER,                  -- set on first matching sign-in
  redeemed_user TEXT REFERENCES users(id) ON DELETE SET NULL
);
CREATE UNIQUE INDEX idx_invites_email ON invites(LOWER(email));

-- 3. Shared join codes. Store a HASH, never the plaintext.
CREATE TABLE join_codes (
  id              TEXT PRIMARY KEY,
  code_hash       TEXT NOT NULL,          -- SHA-256(code), hex
  label           TEXT NOT NULL DEFAULT '',
  domain_restrict TEXT,                   -- optional: only @<this> may redeem
  on_redeem       TEXT NOT NULL DEFAULT 'active'
                  CHECK (on_redeem IN ('active', 'pending')),
  max_uses        INTEGER,                -- NULL = unlimited
  uses            INTEGER NOT NULL DEFAULT 0,
  expires_at      INTEGER,                -- NULL = no expiry
  created_by      TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at      INTEGER NOT NULL,
  revoked_at      INTEGER
);
CREATE UNIQUE INDEX idx_join_codes_hash ON join_codes(code_hash);
```

Each install is one org → these tables are tenant-local in that deploy's D1;
no `tenant_id` needed.

## 5. Admission flow

A new `resolveAdmission()` helper (`apps/worker/src/auth/admission.ts`,
~150 LoC) sits between "identity verified" and "upsert". The IdP callbacks
call it instead of the inline `enforce*Allowlist` → `upsertUser` pair.

```
resolveAdmission({ email, login, idp, accessToken?, joinCode?, env }):
  policy = env.ACCESS_POLICY ?? 'open_domain'

  // a. Trusted explicit allowlist always admits (solo-operator / break-glass).
  if passesEnvAllowlist(identity, env):        # existing enforce*Allowlist
      return ADMIT('active')

  // b. Invited email.
  if invite = findUnredeemedInvite(email):
      markRedeemed(invite, user); return ADMIT('active')

  // c. Join code (carried through the IdP dance in the signed state cookie).
  if joinCode:
      jc = findValidJoinCode(joinCode)         # hash match, not revoked/expired,
                                               # uses<max, domain matches email
      if jc: bumpUses(jc); return ADMIT(jc.on_redeem)
      return REJECT('invalid_join_code')

  // d. Policy fallthrough for a domain-matching unknown.
  if policy == 'request' and passesDomainPrefilter(email, env):
      return ADMIT('pending')
  if policy == 'open_domain' and passesEnvAllowlist(...):  # legacy whole-domain
      return ADMIT('active')

  return REJECT('access_denied')
```

`ADMIT(status)` → `upsertUser` writes that status. The callback then:
- `active` → issue session (existing 5b) **or** `completeMcpAuthorization`
  (existing 5a) unchanged.
- `pending` → **no session.** Render a standalone "access pending approval"
  page. The user re-signs-in after approval.
- `REJECT` → `signInErrorRedirect` with the reason.

**Carry the join code through the redirect dance** the same way `returnTo` /
`oauthRequestId` travel today: add `joinCode?` to `StatePayload`
(`idp/common.ts:15`), set it from `?join=` in each `/idp/{idp}/start`, read it
at callback. The code reaches GitHub/Google **never** — only ctxlayer's own
`/start` URL and the signed, HttpOnly state cookie.

**Re-check status on every request, not just at sign-in.** A suspended user
with a live session cookie must be locked out immediately. Add `status` to
`UserRow` and reject `pending`/`suspended` in the session middleware (where
`findById` runs), not only in the callback.

## 6. Config & policy

New env (typed in `apps/worker/src/env.ts`, never `process.env`):

| Var | Values | Default | Meaning |
| --- | --- | --- | --- |
| `ACCESS_POLICY` | `open_domain` \| `request` \| `invite` | `open_domain` | how unknown-but-domain-matching identities are treated |

- `open_domain` — **current behaviour**: env allowlist (incl. whole-domain
  `ALLOWED_GOOGLE_HD`) admits as `active`. Existing deploys unchanged.
- `request` — opens an admin-approval queue (Users › Pending). If an org/domain
  boundary is configured (`ALLOWED_GITHUB_ORG` / `ALLOWED_GOOGLE_HD`) it's
  members-only: domain-matching unknowns land `pending`, outsiders rejected.
  With **no** boundary configured it's an OPEN queue: anyone who can sign in
  via the IdP lands `pending`. Invites/codes still admit directly.
- `invite` — must be invited or redeem a code; unknowns rejected outright.
  Domain (if set) is a pre-filter on code redemption.

The existing `ALLOWED_*` vars keep working; their *role* (admit vs pre-filter)
now depends on `ACCESS_POLICY`. `ADMIN_EMAILS` still pre-seeds admins.

## 7. Admin surface

New admin REST handlers (mirror `api/admin-users.ts` / `admin-teams.ts`
conventions). **Per-mutation `requireCsrf`** (admin routers gate inline — see
CLAUDE.md security gotcha) and **`audit()` every mutation** (the PR #7 stance).

| Route | Notes |
| --- | --- |
| `GET/POST/DELETE /api/admin/invites` | POST accepts single or pasted bulk list; dedupe; normalise lowercase |
| `GET/POST/DELETE /api/admin/join-codes` | POST returns the plaintext code **once**; list never returns plaintext; DELETE = revoke (`revoked_at`) |
| `GET /api/admin/users?status=pending` | the approval queue |
| `POST /api/admin/users/:id/approve` \| `/reject` | (or `PATCH status`) — flips `pending`→`active` / removes; audited |
| `POST /api/admin/users/:id/suspend` \| `/reactivate` | `active`↔`suspended` |

SPA (`apps/web/`): extend the existing admin **Users** page with a *Pending*
tab + count badge, and add *Invites* and *Join codes* management
(create-shows-code-once, copy button, revoke).

## 8. Sign-in UX

Extend `ErrorReason` (`idp/common.ts:94`) and the `/sign-in` page:

- `pending_approval` — **not an error**; friendly "waiting for an admin to
  approve" state.
- `invite_required`, `invalid_join_code`, `code_expired` — rejection reasons.
- Join-code entry: a code input on `/sign-in` when policy needs it, plus
  support for a `/sign-in?join=CODE` deep link the entity admin can share.

Keep the existing stance that `?error=` reasons reveal policy shape (CLAUDE.md
allowlist gotcha) — acceptable as a UX signal; collapse to a single
`access_denied` only if you later decide to hide the shape.

## 9. Security considerations

- **Join codes are bearer secrets.** Store `SHA-256(code)`, compare in
  constant time, support revoke / expiry / max-uses / domain-restrict, show
  plaintext exactly once. Codes appear in ctxlayer's own `/start` request log
  (not in the IdP URL) — revocable, so acceptable; note it.
- **Pending users get no usable session.** Don't issue a session cookie for
  `pending`; render a static page. Avoids a half-authenticated principal.
- **Suspension is immediate** only if status is re-checked per request (§5).
- Existing rules still apply: never log token-exchange bodies; clear the IdP
  state cookie on every completion path (`idp/complete-mcp.ts` + callback
  success/҂failure branches).

## 10. Backward compatibility & migration

- `status` column `DEFAULT 'active'` backfills all existing users.
- `ACCESS_POLICY` defaults to `open_domain` → **no deploy changes behaviour**
  until an operator opts a tenant into `request`/`invite`.
- The solo-operator dev tenant (`ALLOWED_GITHUB_USERS`) is unaffected — its
  allowlist still admits via branch (a).

## 11. Interaction with the centralized auth broker

This *strengthens* the broker story (K-multitenancy §IdP):

- Admission stays 100% tenant-side; the broker forwards only a verified email.
  The join code is entered on the tenant's `/sign-in` and carried in the
  tenant's state — the broker never sees codes and never maps identity→tenant
  (so still no selector, nothing to enumerate).
- Adopting invite/code admission can **remove the need for GitHub
  org-membership gating**, which is the one allowlist that needs the access
  token across the broker→tenant handoff. Drop org-gating and that handoff
  carries no sensitive material. Net: build entitlement first, and the broker
  gets simpler.

## 12. Phasing & estimates

Each phase is independently shippable.

| Phase | Scope | Est. |
| --- | --- | --- |
| **1** | migration 0019 (status column only) + per-request status re-check + suspend/reactivate admin action + `ACCESS_POLICY=open_domain` default (no behaviour change) | ~1 d |
| **2** | invites table + bulk-invite admin UI + pending-approval queue + `request` policy | ~1.5 d |
| **3** | join codes/links (hashed, domain-restrict, expiry/max-uses) + `invite` policy + sign-in code UX | ~1.5 d |

**~3.5–4.5 days total**, decoupled from the broker.

## 13. Open decisions (operator)

1. **Default policy** — keep `open_domain` globally and opt specific tenants
   into `request`/`invite`, or flip the default for new tenants?
2. **Join codes** — reusable (domain-restricted) vs one-time? Default
   `on_redeem` = `active` or `pending`?
3. **Self-serve request** — offer a "request access" button (lands `pending`),
   or invite/code only (no open request surface)?
4. **Pending session** — confirm: no session at all for `pending` (recommended).
5. **Naming** — `status` column on `users` (recommended, no new parent table)
   vs a separate `members` table.
