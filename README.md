# Bazar Manager — Mobile-first locked entries

A Next.js + Supabase shared bazar tracker for Shuvo, Rabbi, Milon (or any configured users).

## Permission rules
- Members can log in and submit their own bazar entries.
- Once submitted, a member cannot edit or delete the entry.
- Every authenticated member can view all bazar entries and the shared settlement dashboard.
- Only Admin can edit/delete any entry.
- Admin changes are intended to sync to Google Sheets through `/api/sync`.
- Database RLS enforces the lock; hiding buttons in the UI is not the security mechanism.

## Mobile-first UI
The dashboard, forms, settlement list and all-entry feed reflow for phones. Admin edit controls also work on small screens.

## Setup
1. Create a Supabase project and enable Email/Password authentication.
2. Run `supabase-schema.sql` in Supabase SQL Editor.
3. Create one profile row with `role='admin'` for your admin user. Other profiles use `role='member'`.
4. Copy `.env.example` to `.env.local` and fill Supabase + Google service-account values.
5. Share the target Google Sheet with the service-account email as Editor.
6. `npm install`
7. `npm run dev`

## Google Sheet
The existing sync route is kept as the integration point. For production, use a sheet with a stable Entry ID column so admin edits/deletes can be reconciled without duplicate rows.

## Important
The included project is a functional starter and still needs your real Supabase project, auth users, Google service-account credentials, and Sheet ID before it becomes a live deployed service.
