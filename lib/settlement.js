/**
 * Calculate settlement for active members.
 * Supports member IDs (UUIDs) as primary keys, duplicate member names, and exact cent reconciliation.
 *
 * @param {Object} totals - Map of totals: { [memberIdOrName]: amount }
 * @param {Array<{id: string, name: string}>|Object|number} [membersOrCount] -
 *   - Array of active member objects: [{ id, name, ... }]
 *   - Or Map of { [id]: name }
 *   - Or number (override count)
 * @returns {{ total: number, share: number, memberCount: number, balances: Object, transactions: Array }}
 */
export function settlement(totals = {}, membersOrCount) {
  let memberKeys = [];
  const nameMap = {};

  if (Array.isArray(membersOrCount)) {
    // Array of member objects: [{ id, name }, ...]
    memberKeys = membersOrCount.map((m) => {
      const key = String(m.id ?? m.name);
      nameMap[key] = m.name || key;
      return key;
    });
  } else if (membersOrCount && typeof membersOrCount === 'object') {
    // Map of { [id]: name }
    memberKeys = Object.keys(membersOrCount);
    for (const k of memberKeys) {
      nameMap[k] = membersOrCount[k];
    }
  } else {
    // Legacy fallback: keys of totals
    memberKeys = Object.keys(totals);
    for (const k of memberKeys) {
      nameMap[k] = k;
    }
  }

  // Also include any keys present in totals that might not be in memberKeys
  for (const k of Object.keys(totals)) {
    if (!memberKeys.includes(k)) {
      memberKeys.push(k);
      if (!nameMap[k]) nameMap[k] = k;
    }
  }

  const count =
    typeof membersOrCount === 'number' && membersOrCount > 0
      ? membersOrCount
      : Math.max(memberKeys.length, 1);

  // Total expenditure rounded to 2 decimal places
  const total =
    Math.round(
      memberKeys.reduce((s, k) => s + Number(totals[k] || 0), 0) * 100
    ) / 100;

  // Equal share per participating member
  const share =
    memberKeys.length > 0 ? Math.round((total / count) * 100) / 100 : 0;

  // Balances: positive = receive, negative = pay
  const bal = {};
  for (const k of memberKeys) {
    bal[k] = Math.round((Number(totals[k] || 0) - share) * 100) / 100;
  }

  // Cent reconciliation: ensure net balances sum exactly to zero
  const netSum =
    Math.round(
      memberKeys.reduce((acc, k) => acc + (bal[k] || 0), 0) * 100
    ) / 100;

  if (netSum !== 0 && memberKeys.length > 0) {
    // Member with highest absolute balance absorbs cent discrepancy
    const sortedByAbs = [...memberKeys].sort(
      (a, b) => Math.abs(bal[b]) - Math.abs(bal[a])
    );
    const target = sortedByAbs[0];
    bal[target] = Math.round((bal[target] - netSum) * 100) / 100;
  }

  const debtors = memberKeys
    .filter((k) => (bal[k] || 0) < -0.001)
    .map((k) => ({ key: k, v: Math.round(-(bal[k] || 0) * 100) / 100 }))
    .sort((a, b) => b.v - a.v);

  const creditors = memberKeys
    .filter((k) => (bal[k] || 0) > 0.001)
    .map((k) => ({ key: k, v: Math.round((bal[k] || 0) * 100) / 100 }))
    .sort((a, b) => b.v - a.v);

  const tx = [];
  let i = 0;
  let j = 0;
  while (i < debtors.length && j < creditors.length) {
    const a = Math.min(debtors[i].v, creditors[j].v);
    const amt = Math.round(a * 100) / 100;
    if (amt > 0) {
      tx.push({
        fromId: debtors[i].key,
        fromName: nameMap[debtors[i].key] || debtors[i].key,
        from: nameMap[debtors[i].key] || debtors[i].key,
        toId: creditors[j].key,
        toName: nameMap[creditors[j].key] || creditors[j].key,
        to: nameMap[creditors[j].key] || creditors[j].key,
        amount: amt,
      });
    }
    debtors[i].v = Math.round((debtors[i].v - amt) * 100) / 100;
    creditors[j].v = Math.round((creditors[j].v - amt) * 100) / 100;
    if (debtors[i].v <= 0.001) i++;
    if (creditors[j].v <= 0.001) j++;
  }

  return {
    total,
    share,
    memberCount: count,
    balances: bal,
    transactions: tx,
  };
}
