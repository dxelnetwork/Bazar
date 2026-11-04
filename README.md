# Bazar Manager — Shared Bazar Tracker

A Next.js 15 + React 19 + Supabase shared grocery and expense tracker with monthly accounting cycles. Supabase PostgreSQL serves as the **only source of truth** for all user profiles, monthly periods, entries, calculations, and settlement history.

---

## Security & Architecture Highlights

- **Profile Privilege Escalation Protection**: Database triggers prevent non-admin members from modifying their own or other users' roles, account status, or user IDs. Only Admins can modify roles or status.
- **Closed Month Immutability**:
  - Once a monthly period is closed, its record and settlement snapshot become permanently immutable.
  - No user (including Admin) can edit, move, or delete bazar entries belonging to a closed month.
  - Direct updates marking a month closed are blocked; closure must occur through the authoritative `close_month()` RPC.
- **Authoritative Server-Side Settlements**:
  - Totals, equal member shares, balances, and debtor-to-creditor transactions are calculated 100% server-side directly from database records.
  - Member totals and balances are keyed by user UUID, ensuring duplicate display names never collide or corrupt balances.
  - Month closure is rejected if there are no active participating members.
- **Single Source of Truth**: All operations execute directly against Supabase PostgreSQL with strict Row Level Security (RLS) and `SECURITY DEFINER` RPCs with `search_path = public`.

---

## Database Migrations & Setup Guide

### Scenario A: Upgrading an Existing Production Database

> [!IMPORTANT]
> **DO NOT** re-run `001_monthly_cycles.sql` on a database where it has already been applied. Re-running earlier migrations is unnecessary and not recommended.

To upgrade an existing production database that already has `001_monthly_cycles.sql` applied:
1. Open the **Supabase Dashboard** -> **SQL Editor**.
2. Run only the new security migration:
   ```
   supabase/migrations/002_security_hardening.sql
   ```
   This migration is non-destructive, safe, and idempotent:
   - Adds profile privilege escalation triggers.
   - Enforces closed month immutability for entries and month snapshots.
   - Upgrades `close_month()` to use UUID-keyed calculations and reject zero-member closures.
   - Restricts RPC execution permissions to `authenticated` users only.
   - Preserves all existing profiles, historical entries, and monthly cycle data intact.

---

### Scenario B: Fresh Database Setup

For a new, clean Supabase project:
1. Open the **Supabase Dashboard** -> **SQL Editor**.
2. Run the complete reference schema:
   ```
   supabase-schema.sql
   ```
   *(Alternatively, run `001_monthly_cycles.sql` followed by `002_security_hardening.sql` in sequence).*
3. Create your initial admin user in Supabase Authentication.
4. In the `profiles` table, set `role = 'admin'` for your admin account.

---

## Environment Variables

Copy `.env.example` to `.env.local` and configure your credentials:

```bash
# Public Supabase credentials (frontend App Router)
NEXT_PUBLIC_SUPABASE_URL=https://your-project.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=your-anon-key

# Private Server-Side Admin Key (API Routes only — never exposed to client)
SUPABASE_SERVICE_ROLE_KEY=your-service-role-key
```

---

## Local Development & Testing

```bash
# Install dependencies
npm install

# Run automated security and settlement test suite
npm test

# Production build
npm run build

# Start production server
npm start
```
