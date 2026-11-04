/**
 * Calculate settlement for any number of members dynamically.
 * Handles equal shares, individual balances, and minimal transaction settlements.
 *
 * @param {Object} totals - { memberName: totalPaid, ... }
 * @param {number} [memberCount] - Optional override for member count.
 * @returns {{ total: number, share: number, balances: Object, transactions: Array }}
 */
export function settlement(totals, memberCount) {
  const names = Object.keys(totals);
  const total = Math.round(names.reduce((s, n) => s + Number(totals[n] || 0), 0) * 100) / 100;

  // Dynamic member count — supports any number of active members >= 1
  const count = memberCount || Math.max(names.length, 1);
  const share = Math.round((total / count) * 100) / 100;

  // Compute individual balances: positive = receive, negative = pay
  const bal = Object.fromEntries(
    names.map((n) => [n, Math.round((Number(totals[n] || 0) - share) * 100) / 100])
  );

  // Reconcile any rounding cent discrepancies so net balances sum exactly to zero
  const netSum = Math.round(names.reduce((acc, n) => acc + bal[n], 0) * 100) / 100;
  if (netSum !== 0 && names.length > 0) {
    // Find the person with the largest absolute balance to absorb the 1-cent difference
    const sortedByAbs = [...names].sort((a, b) => Math.abs(bal[b]) - Math.abs(bal[a]));
    const target = sortedByAbs[0];
    bal[target] = Math.round((bal[target] - netSum) * 100) / 100;
  }

  const debtors = names
    .filter((n) => bal[n] < -0.001)
    .map((n) => ({ n, v: Math.round(-bal[n] * 100) / 100 }))
    .sort((a, b) => b.v - a.v);

  const creditors = names
    .filter((n) => bal[n] > 0.001)
    .map((n) => ({ n, v: Math.round(bal[n] * 100) / 100 }))
    .sort((a, b) => b.v - a.v);

  const tx = [];
  let i = 0;
  let j = 0;
  while (i < debtors.length && j < creditors.length) {
    const a = Math.min(debtors[i].v, creditors[j].v);
    const amt = Math.round(a * 100) / 100;
    if (amt > 0) {
      tx.push({ from: debtors[i].n, to: creditors[j].n, amount: amt });
    }
    debtors[i].v = Math.round((debtors[i].v - amt) * 100) / 100;
    creditors[j].v = Math.round((creditors[j].v - amt) * 100) / 100;
    if (debtors[i].v <= 0.001) i++;
    if (creditors[j].v <= 0.001) j++;
  }

  return { total, share, balances: bal, transactions: tx };
}
