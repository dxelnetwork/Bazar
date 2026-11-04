export function settlement(totals){
  const names=Object.keys(totals); const total=names.reduce((s,n)=>s+Number(totals[n]||0),0);
  const share=total/3;
  const bal=Object.fromEntries(names.map(n=>[n,Math.round((Number(totals[n]||0)-share)*100)/100]));
  const debtors=names.filter(n=>bal[n]<0).map(n=>({n,v:-bal[n]}));
  const creditors=names.filter(n=>bal[n]>0).map(n=>({n,v:bal[n]}));
  const tx=[]; let i=0,j=0;
  while(i<debtors.length && j<creditors.length){
    const a=Math.min(debtors[i].v,creditors[j].v); const amt=Math.round(a*100)/100;
    if(amt>0) tx.push({from:debtors[i].n,to:creditors[j].n,amount:amt});
    debtors[i].v=Math.round((debtors[i].v-amt)*100)/100; creditors[j].v=Math.round((creditors[j].v-amt)*100)/100;
    if(debtors[i].v<=0)i++; if(creditors[j].v<=0)j++;
  }
  return {total,share,balances:bal,transactions:tx};
}
