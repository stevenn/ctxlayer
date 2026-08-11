-- A7 (2026-08 review): server-side invalidation for the SPA session cookie.
-- The cookie is a stateless 30-day HMAC bearer; without this, sign-out only
-- clears the browser's copy and a stolen cookie stays valid until exp.
-- The cookie embeds the epoch it was minted under; the per-request user
-- fetch in auth/middleware compares it to this column, so bumping the
-- column (sign-out, admin suspend) kills every outstanding cookie at once.
-- Additive column on a referenced parent — no rebuild needed (G1 only
-- bites on DROP/recreate).
ALTER TABLE users ADD COLUMN session_epoch INTEGER NOT NULL DEFAULT 0;
