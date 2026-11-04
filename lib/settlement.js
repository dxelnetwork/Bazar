/**
 * Calculate settlement for any number of members.
 * @param {Object} totals - { memberName: totalPaid, ... }
 * @param {number} [memberCount] - Override member count (for closed month snapshots).
 *   When omitted, uses the number of keys in `totals` that have non-zero amounts,
 *   but never less than 1.
 * @returns {{ total, share, balances, transactions }}
 */
export function settlement(totals, memberCount) {
  const names = Object.keys(totals);
  const total = names.reduce((s, n) => s + Number(totals[n] || 0), 0);

  // Dynamic member count — no hardcoded divisor
  const count = memberCount || Math.max(names.length, 1);
  const share = Math.round((total / count) * 100) / 100;

  const bal = Object.fromEntries(
    names.map((n) => [n, Math.round((Number(totals[n] || 0) - share) * 100) / 100])
  );

  const debtors = names
    .filter((n) => bal[n] < 0)
    .map((n) => ({ n, v: -bal[n] }))
    .sort((a, b) => b.v - a.v);

  const creditors = names
    .filter((n) => bal[n] > 0)
    .map((n) => ({ n, v: bal[n] }))
    .sort((a, b) => b.v - a.v);

  const tx = [];
  let i = 0;
  let j = 0;
  while (i < debtors.length && j < creditors.length) {
    const a = Math.min(debtors[i].v, creditors[j].v);
    const amt = Math.round(a * 100) / 100;
    if (amt > 0) tx.push({ from: debtors[i].n, to: creditors[j].n, amount: amt });
    debtors[i].v = Math.round((debtors[i].v - amt) * 100) / 100;
    creditors[j].v = Math.round((creditors[j].v - amt) * 100) / 100;
    if (debtors[i].v <= 0) i++;
    if (creditors[j].v <= 0) j++;
  }

  return { total, share, balances: bal, transactions: tx };
}
