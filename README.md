# Bazar Manager — Mobile-first locked entries

A Next.js + Supabase shared bazar tracker with monthly accounting cycles. Supabase PostgreSQL serves as the single source of truth for all data, roles, calculations, and snapshots.

## Permission rules
- Members can log in and submit their own bazar entries to the active month.
- Inactive members cannot submit entries.
- Once submitted, a member cannot edit or delete the entry.
- Every authenticated member can view all bazar entries and the shared settlement dashboard.
- Only Admin can edit/delete entries, manage members, close months, and start new months.
- Database RLS and SECURITY DEFINER RPC functions enforce access controls at the PostgreSQL layer.

## Mobile-first UI
The dashboard, forms, settlement list, history, and member management reflow seamlessly for phones and desktop.

## Setup
1. Create a Supabase project and enable Email/Password authentication.
2. Run `supabase/migrations/001_monthly_cycles.sql` in Supabase SQL Editor.
3. Assign `role='admin'` to your admin user in `profiles`. Other members use `role='member'`.
4. Copy `.env.example` to `.env.local` and fill in Supabase credentials (`NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`).
5. `npm install`
6. `npm run dev`
