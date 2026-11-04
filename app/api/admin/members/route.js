import { NextResponse } from 'next/server';
import { getAdminUser } from '../../../../lib/serverAuth.js';
import { createAdminClient } from '../../../../lib/supabaseAdmin.js';

/**
 * GET /api/admin/members
 * Returns all member profiles. Admin-only.
 */
export async function GET(request) {
  try {
    const { user, error: authError } = await getAdminUser(request);
    if (authError) {
      return NextResponse.json({ error: authError }, { status: 401 });
    }

    const adminClient = createAdminClient();

    // Fetch all profiles
    const { data: profiles, error: profilesError } = await adminClient
      .from('profiles')
      .select('id, name, role, whatsapp, status, created_at')
      .order('created_at', { ascending: true });

    if (profilesError) {
      return NextResponse.json({ error: profilesError.message }, { status: 500 });
    }

    // Fetch entry totals for the active month (if any)
    const { data: activeMonth } = await adminClient
      .from('bazar_months')
      .select('id')
      .eq('status', 'active')
      .single();

    let entryTotals = {};
    if (activeMonth) {
      const { data: totals } = await adminClient
        .from('bazar_entries')
        .select('user_id, amount')
        .eq('month_id', activeMonth.id);

      if (totals) {
        entryTotals = totals.reduce((acc, entry) => {
          acc[entry.user_id] = (acc[entry.user_id] || 0) + Number(entry.amount || 0);
          return acc;
        }, {});
      }
    }

    const members = profiles.map((p) => ({
      ...p,
      activeMonthTotal: entryTotals[p.id] || 0,
    }));

    // Enrich with email addresses from Supabase Auth
    try {
      const { data: { users } } = await adminClient.auth.admin.listUsers();
      const emailMap = {};
      if (users) {
        users.forEach((u) => { emailMap[u.id] = u.email; });
      }
      members.forEach((m) => { m.email = emailMap[m.id] || null; });
    } catch (_) {
      // If listing users fails, proceed without emails
    }

    return NextResponse.json({ members });
  } catch (e) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}

/**
 * POST /api/admin/members
 * Creates a new member. Admin-only.
 *
 * Body: { name, email, password, confirmPassword, whatsapp? }
 */
export async function POST(request) {
  try {
    const { user, error: authError } = await getAdminUser(request);
    if (authError) {
      return NextResponse.json({ error: authError }, { status: 401 });
    }

    const body = await request.json();
    const { name, email, password, confirmPassword, whatsapp } = body;

    // --- Validation ---
    const errors = [];
    if (!name?.trim()) errors.push('Name is required');
    if (!email?.trim()) errors.push('Email is required');
    else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) errors.push('Invalid email format');
    if (!password) errors.push('Password is required');
    else if (password.length < 6) errors.push('Password must be at least 6 characters');
    if (password !== confirmPassword) errors.push('Passwords do not match');

    if (errors.length > 0) {
      return NextResponse.json({ error: errors.join(', ') }, { status: 400 });
    }

    const adminClient = createAdminClient();

    // Create the user in Supabase Auth
    const { data: authData, error: createError } = await adminClient.auth.admin.createUser({
      email: email.trim().toLowerCase(),
      password,
      email_confirm: true, // Auto-confirm so they can log in immediately
      user_metadata: { name: name.trim() },
    });

    if (createError) {
      // Handle duplicate email gracefully
      if (createError.message?.includes('already been registered') || createError.message?.includes('duplicate')) {
        return NextResponse.json({ error: 'A user with this email already exists' }, { status: 409 });
      }
      return NextResponse.json({ error: createError.message }, { status: 500 });
    }

    const newUser = authData.user;

    // Create the profile in the profiles table
    const { data: profile, error: profileError } = await adminClient
      .from('profiles')
      .upsert({
        id: newUser.id,
        name: name.trim(),
        role: 'member',
        whatsapp: whatsapp?.trim() || null,
      })
      .select('id, name, role, whatsapp, created_at')
      .single();

    if (profileError) {
      // Rollback: delete the auth user since profile creation failed
      try {
        await adminClient.auth.admin.deleteUser(newUser.id);
      } catch (_rollbackErr) {
        // Log but don't throw — the primary error is more important
        console.error('Failed to rollback auth user after profile creation failure');
      }
      return NextResponse.json({ error: `Profile creation failed: ${profileError.message}` }, { status: 500 });
    }

    return NextResponse.json({ member: profile }, { status: 201 });
  } catch (e) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
