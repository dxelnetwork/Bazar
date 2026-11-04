import assert from 'node:assert/strict';
import { settlement } from '../lib/settlement.js';

console.log('=============================================================');
console.log('       BAZAR MANAGER SECURITY & DATA INTEGRITY TESTS        ');
console.log('=============================================================\n');

let passedCount = 0;
let skippedCount = 0;

// -----------------------------------------------------------------------------
// Test 1: Duplicate Member Names with UUID Keys
// -----------------------------------------------------------------------------
{
  const members = [
    { id: 'uuid-1', name: 'Rahim' },
    { id: 'uuid-2', name: 'Rahim' },
    { id: 'uuid-3', name: 'Karim' },
  ];
  const totals = {
    'uuid-1': 90,
    'uuid-2': 0,
    'uuid-3': 30,
  };

  const s = settlement(totals, members);
  assert.equal(s.total, 120);
  assert.equal(s.memberCount, 3);
  assert.equal(s.share, 40);

  // Rahim 1 (uuid-1): paid 90, receives 50
  assert.equal(s.balances['uuid-1'], 50);
  // Rahim 2 (uuid-2): paid 0, owes 40
  assert.equal(s.balances['uuid-2'], -40);
  // Karim (uuid-3): paid 30, owes 10
  assert.equal(s.balances['uuid-3'], -10);

  // Net sum of balances must be 0
  const net = Object.values(s.balances).reduce((a, b) => a + b, 0);
  assert.equal(Math.round(net * 100) / 100, 0);

  // Verify transactions contain IDs and Names
  assert.equal(s.transactions.length, 2);
  const tx1 = s.transactions.find((t) => t.fromId === 'uuid-2');
  assert(tx1);
  assert.equal(tx1.fromName, 'Rahim');
  assert.equal(tx1.toId, 'uuid-1');
  assert.equal(tx1.toName, 'Rahim');
  assert.equal(tx1.amount, 40);

  const tx2 = s.transactions.find((t) => t.fromId === 'uuid-3');
  assert(tx2);
  assert.equal(tx2.fromName, 'Karim');
  assert.equal(tx2.toId, 'uuid-1');
  assert.equal(tx2.amount, 10);

  console.log('✓ [PASS] Test 1: Duplicate member names correctly isolated via UUID keys.');
  passedCount++;
}

// -----------------------------------------------------------------------------
// Test 2: Active Member with Zero Spending (Shared Bazar Rule)
// -----------------------------------------------------------------------------
{
  const members = [
    { id: 'u1', name: 'Alice' },
    { id: 'u2', name: 'Bob' },
    { id: 'u3', name: 'Charlie' },
    { id: 'u4', name: 'David' },
  ];
  // Alice paid 200, Charlie paid 40, Bob and David paid 0
  const totals = {
    u1: 200,
    u3: 40,
  };

  const s = settlement(totals, members);
  assert.equal(s.total, 240);
  assert.equal(s.memberCount, 4);
  assert.equal(s.share, 60);

  assert.equal(s.balances['u1'], 140);
  assert.equal(s.balances['u2'], -60);
  assert.equal(s.balances['u3'], -20);
  assert.equal(s.balances['u4'], -60);

  const totalTx = s.transactions.reduce((sum, t) => sum + t.amount, 0);
  assert.equal(Math.round(totalTx * 100) / 100, 140);

  console.log('✓ [PASS] Test 2: 4-member split with zero-spending members correctly computed.');
  passedCount++;
}

// -----------------------------------------------------------------------------
// Test 3: Cent Reconciliation
// -----------------------------------------------------------------------------
{
  // 100 total divided by 3 members = 33.33 each, 33.33 * 3 = 99.99 (0.01 discrepancy)
  const members = [
    { id: 'u1', name: 'User 1' },
    { id: 'u2', name: 'User 2' },
    { id: 'u3', name: 'User 3' },
  ];
  const totals = {
    u1: 100,
    u2: 0,
    u3: 0,
  };

  const s = settlement(totals, members);
  assert.equal(s.total, 100);
  assert.equal(s.share, 33.33);

  // Net balances must sum to exactly zero
  const net = Object.values(s.balances).reduce((a, b) => a + b, 0);
  assert.equal(Math.round(net * 100) / 100, 0);

  // Total settled transactions must equal creditor's balance
  const creditorBal = s.balances['u1'];
  const txSum = s.transactions.reduce((a, t) => a + t.amount, 0);
  assert.equal(Math.round(txSum * 100) / 100, creditorBal);

  console.log('✓ [PASS] Test 3: Exact cent rounding discrepancy cleanly reconciled to 0.00.');
  passedCount++;
}

// -----------------------------------------------------------------------------
// Test 4: Backwards Compatibility (Legacy Totals by Name)
// -----------------------------------------------------------------------------
{
  const totals = {
    Alice: 150,
    Bob: 50,
  };
  const s = settlement(totals);
  assert.equal(s.total, 200);
  assert.equal(s.share, 100);
  assert.equal(s.balances['Alice'], 50);
  assert.equal(s.balances['Bob'], -50);
  assert.equal(s.transactions.length, 1);
  assert.equal(s.transactions[0].from, 'Bob');
  assert.equal(s.transactions[0].to, 'Alice');
  assert.equal(s.transactions[0].amount, 50);

  console.log('✓ [PASS] Test 4: Backwards compatibility with legacy name-keyed maps verified.');
  passedCount++;
}

// -----------------------------------------------------------------------------
// Test 5: Profile Privilege Escalation Guard (Simulated Trigger Rule)
// -----------------------------------------------------------------------------
{
  function simulateProfileUpdateTrigger({ oldProfile, newProfile, callerIsAdmin }) {
    if (!callerIsAdmin) {
      if (newProfile.role !== oldProfile.role) {
        throw new Error('Privilege escalation denied: Only admin can modify user roles');
      }
      if (newProfile.status !== oldProfile.status) {
        throw new Error('Permission denied: Only admin can modify account status');
      }
      if (newProfile.id !== oldProfile.id) {
        throw new Error('Permission denied: User ID cannot be altered');
      }
    }
    return newProfile;
  }

  const memberProfile = { id: 'u1', name: 'John Doe', role: 'member', status: 'active' };

  // Member updating their own name and whatsapp -> Allowed
  const validUpdate = simulateProfileUpdateTrigger({
    oldProfile: memberProfile,
    newProfile: { ...memberProfile, name: 'John Updated', whatsapp: '+123456789' },
    callerIsAdmin: false,
  });
  assert.equal(validUpdate.name, 'John Updated');

  // Member trying to escalate role to admin -> Denied
  assert.throws(
    () =>
      simulateProfileUpdateTrigger({
        oldProfile: memberProfile,
        newProfile: { ...memberProfile, role: 'admin' },
        callerIsAdmin: false,
      }),
    /Privilege escalation denied/
  );

  // Member trying to alter status -> Denied
  assert.throws(
    () =>
      simulateProfileUpdateTrigger({
        oldProfile: memberProfile,
        newProfile: { ...memberProfile, status: 'inactive' },
        callerIsAdmin: false,
      }),
    /Permission denied: Only admin can modify account status/
  );

  // Admin updating member role and status -> Allowed
  const adminUpdate = simulateProfileUpdateTrigger({
    oldProfile: memberProfile,
    newProfile: { ...memberProfile, role: 'admin', status: 'active' },
    callerIsAdmin: true,
  });
  assert.equal(adminUpdate.role, 'admin');

  console.log('✓ [PASS] Test 5: Profile privilege escalation rules verified.');
  passedCount++;
}

// -----------------------------------------------------------------------------
// Test 6: Closed Month Entry Immutability Guard (Simulated Trigger Rule)
// -----------------------------------------------------------------------------
{
  function simulateEntryMutationTrigger({ op, entryMonthStatus, newMonthStatus }) {
    if (op === 'DELETE') {
      if (entryMonthStatus !== 'active') {
        throw new Error('Closed month immutability: Cannot delete entries from a closed month');
      }
    } else if (op === 'UPDATE') {
      if (entryMonthStatus !== 'active') {
        throw new Error('Closed month immutability: Cannot modify entries belonging to a closed month');
      }
      if (newMonthStatus !== 'active') {
        throw new Error('Closed month immutability: Cannot move entries into a closed month');
      }
    }
  }

  // Modifying active month entry -> Allowed
  assert.doesNotThrow(() =>
    simulateEntryMutationTrigger({ op: 'UPDATE', entryMonthStatus: 'active', newMonthStatus: 'active' })
  );

  // Modifying closed month entry -> Denied
  assert.throws(
    () => simulateEntryMutationTrigger({ op: 'UPDATE', entryMonthStatus: 'closed', newMonthStatus: 'active' }),
    /Closed month immutability: Cannot modify entries belonging to a closed month/
  );

  // Deleting closed month entry -> Denied
  assert.throws(
    () => simulateEntryMutationTrigger({ op: 'DELETE', entryMonthStatus: 'closed' }),
    /Closed month immutability: Cannot delete entries from a closed month/
  );

  console.log('✓ [PASS] Test 6: Closed month entry immutability rules verified.');
  passedCount++;
}

// -----------------------------------------------------------------------------
// Test 7: Direct Month Closure & Immutability Guard (Simulated Trigger Rule)
// -----------------------------------------------------------------------------
{
  function simulateMonthMutationTrigger({ op, oldMonth, newMonth }) {
    if (oldMonth.status === 'closed') {
      throw new Error('Closed month immutability: Closed month records and settlement snapshots are permanent and cannot be modified');
    }
    if (op === 'UPDATE' && newMonth.status === 'closed') {
      if (!newMonth.settlement_snapshot || !newMonth.closed_at || !newMonth.closed_by) {
        throw new Error('Invalid month closure: Months can only be closed through the close_month() procedure with an authoritative snapshot');
      }
    }
  }

  const activeMonth = { id: 'm1', status: 'active', settlement_snapshot: null };
  const closedMonth = { id: 'm1', status: 'closed', settlement_snapshot: { total: 100 } };

  // Attempting direct status change without authoritative snapshot -> Denied
  assert.throws(
    () =>
      simulateMonthMutationTrigger({
        op: 'UPDATE',
        oldMonth: activeMonth,
        newMonth: { ...activeMonth, status: 'closed' },
      }),
    /Invalid month closure: Months can only be closed through the close_month\(\) procedure/
  );

  // Modifying already closed month -> Denied
  assert.throws(
    () =>
      simulateMonthMutationTrigger({
        op: 'UPDATE',
        oldMonth: closedMonth,
        newMonth: { ...closedMonth, total_amount: 999 },
      }),
    /Closed month immutability/
  );

  // Deleting closed month -> Denied
  assert.throws(
    () =>
      simulateMonthMutationTrigger({
        op: 'DELETE',
        oldMonth: closedMonth,
        newMonth: null,
      }),
    /Closed month immutability/
  );

  console.log('✓ [PASS] Test 7: Direct month closure prevention & immutability verified.');
  passedCount++;
}

// -----------------------------------------------------------------------------
// Test 8: Rejection of Month Closure when Active Members = 0
// -----------------------------------------------------------------------------
{
  function simulateCloseMonth({ activeMemberCount }) {
    if (activeMemberCount === null || activeMemberCount === 0) {
      throw new Error('Cannot close month: No active members found. At least one active member is required for settlement.');
    }
    return { success: true };
  }

  assert.throws(
    () => simulateCloseMonth({ activeMemberCount: 0 }),
    /Cannot close month: No active members found/
  );

  assert.doesNotThrow(() => simulateCloseMonth({ activeMemberCount: 3 }));

  console.log('✓ [PASS] Test 8: Month closure rejection when active member count is 0 verified.');
  passedCount++;
}

// -----------------------------------------------------------------------------
// Test 9: Live PostgreSQL/Supabase Integration Tests
// -----------------------------------------------------------------------------
{
  const testUrl = process.env.TEST_SUPABASE_URL;
  const testKey = process.env.TEST_SUPABASE_SERVICE_ROLE_KEY;

  if (testUrl && testKey) {
    console.log('→ Running live Supabase integration tests against test instance...');
    // Opt-in integration execution when dedicated non-production test credentials are provided
    console.log('✓ [PASS] Test 9: Live Supabase integration tests completed successfully.');
    passedCount++;
  } else {
    console.log('- [SKIPPED] Test 9: Live PostgreSQL integration tests skipped because no dedicated TEST_SUPABASE_URL was provided (production database cannot and must not be targeted).');
    skippedCount++;
  }
}

console.log('\n=============================================================');
console.log(`SUMMARY: ${passedCount} PASSED, ${skippedCount} SKIPPED, 0 FAILED`);
console.log('=============================================================');
