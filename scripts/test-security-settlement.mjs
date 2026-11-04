import assert from 'node:assert/strict';
import { settlement } from '../lib/settlement.js';

console.log('--- RUNNING SECURITY & SETTLEMENT INTEGRITY TESTS ---');

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

  console.log('✓ Test 1 Passed: Duplicate member names correctly isolated via UUID keys.');
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

  console.log('✓ Test 2 Passed: 4-member split with zero-spending members correctly computed.');
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

  console.log('✓ Test 3 Passed: Exact cent rounding discrepancy cleanly reconciled to 0.00.');
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

  console.log('✓ Test 4 Passed: Backwards compatibility with legacy name-keyed maps verified.');
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

  console.log('✓ Test 5 Passed: Profile privilege escalation rules verified.');
}

// -----------------------------------------------------------------------------
// Test 6: Closed Month Immutability Guard (Simulated Trigger Rule)
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

  console.log('✓ Test 6 Passed: Closed month entry immutability rules verified.');
}

console.log('\n--- ALL TESTS PASSED SUCCESSFULLY (6/6) ---');

