// DOTS-142 customer-facing account portal. No owner session: access is a signed, expiring, revocable
// token scoped to one account. Shows only that account's invoices, payment status, contract evidence and
// meeting history. Internal transcripts, notes, model output and other accounts are never loaded.
import type {Metadata} from 'next';
import type {CSSProperties} from 'react';
import {RevenueOperations,OperationError} from '@dots/operations';
import {withOperations} from '../../../lib/operations';
export const dynamic='force-dynamic';
export const metadata:Metadata={title:'Account portal',robots:{index:false,follow:false},referrer:'no-referrer'};
type PortalView=Awaited<ReturnType<RevenueOperations['portalView']>>;
const money=(cents:number)=>new Intl.NumberFormat('en-US',{style:'currency',currency:'USD'}).format(cents/100);
const day=(value:unknown)=>value?new Date(String(value)).toLocaleDateString('en-US',{year:'numeric',month:'short',day:'numeric'}):'—';
const label=(value:string)=>value.replaceAll('_',' ');
const shell:CSSProperties={maxWidth:880,margin:'0 auto',padding:'40px 16px',color:'#e8edf5',fontFamily:'system-ui,-apple-system,Segoe UI,sans-serif',lineHeight:1.5};
const card:CSSProperties={background:'#151b26',border:'1px solid #2a3344',borderRadius:12,padding:20,marginBottom:16};
const muted:CSSProperties={color:'#9aa6b8'};
export default async function Portal({params}:{params:Promise<{token:string}>}){
 const {token}=await params;let view:PortalView|null=null;
 try{view=await withOperations((client,ctx)=>new RevenueOperations(client,ctx).portalView(decodeURIComponent(token)));}catch(error){if(!(error instanceof OperationError))console.error('portal view unavailable');view=null;}
 if(!view)return <main style={{...shell,minHeight:'100vh',background:'#0d1118'}}><section style={card}><h1>Link unavailable</h1><p style={muted}>This account link is invalid, has expired or was revoked. Please ask your contact for a new link.</p></section></main>;
 return <main style={{...shell,minHeight:'100vh',background:'#0d1118'}}>
  <header style={{marginBottom:24}}><p style={{...muted,letterSpacing:2,fontSize:12,margin:0}}>ACCOUNT PORTAL</p><h1 style={{margin:'4px 0'}}>{view.account.name}</h1><p style={muted}>This private link expires on {day(view.expiresAt)}.</p></header>
  <section aria-labelledby="portal-invoices" style={card}><h2 id="portal-invoices">Invoices and payments</h2>
   {view.invoices.length?<div style={{overflowX:'auto'}}><table style={{width:'100%',borderCollapse:'collapse'}}><caption style={{...muted,textAlign:'left'}}>Payment status comes only from the payment processor.</caption><thead><tr><th scope="col" style={{textAlign:'left'}}>Invoice</th><th scope="col" style={{textAlign:'left'}}>Status</th><th scope="col" style={{textAlign:'right'}}>Amount</th><th scope="col" style={{textAlign:'left'}}>Due</th></tr></thead>
    <tbody>{view.invoices.map(invoice=><tr key={invoice.invoiceNumber} style={{borderTop:'1px solid #2a3344'}}><td>{invoice.invoiceNumber}<br/><span style={muted}>{invoice.label}</span></td><td>{label(invoice.state)}{invoice.sandbox&&['paid','refunded','disputed'].includes(invoice.state)?<><br/><span style={muted}>Test-mode receipt, not a real payment</span></>:null}{invoice.payments.map((payment,index)=><div key={index} style={muted}>{label(payment.kind)} {money(payment.amountCents)} · {day(payment.occurredAt)}</div>)}</td><td style={{textAlign:'right'}}>{money(invoice.amountCents)}</td><td>{day(invoice.dueAt)}</td></tr>)}</tbody></table></div>:<p style={muted}>No issued invoices for this account yet.</p>}
  </section>
  <section aria-labelledby="portal-contracts" style={card}><h2 id="portal-contracts">Quotes and contract evidence</h2>
   {view.contracts.length?view.contracts.map(contract=><article key={contract.quoteNumber} style={{borderTop:'1px solid #2a3344',paddingTop:12,marginTop:12}}><h3 style={{margin:0}}>{contract.quoteNumber} · {money(contract.totalCents)}{contract.billingInterval!=='one_time'?` per ${contract.billingInterval}`:''}</h3>
    <p style={muted}>{label(contract.state)}{contract.binding?' · binding agreement':contract.state==='accepted'?' · accepted, not yet binding':''} · sent {day(contract.sentAt)}{contract.acceptedAt?` · accepted ${day(contract.acceptedAt)}`:''}</p>
    <p style={{whiteSpace:'pre-wrap'}}>{contract.terms}</p><p style={{...muted,fontSize:12,wordBreak:'break-all'}}>Evidence fingerprint: <code>{contract.evidenceHash}</code></p></article>):<p style={muted}>No quotes have been shared with this account.</p>}
  </section>
  <section aria-labelledby="portal-subscriptions" style={card}><h2 id="portal-subscriptions">Subscriptions</h2>
   {view.subscriptions.length?<ul>{view.subscriptions.map((item,index)=><li key={index}>{item.label}: {label(item.state)} · {money(item.amountCents)} per {item.billingInterval}{item.renewsAt?` · next date ${day(item.renewsAt)}`:''}</li>)}</ul>:<p style={muted}>No subscriptions.</p>}
  </section>
  <section aria-labelledby="portal-history" style={card}><h2 id="portal-history">Meeting history</h2>
   {view.history.length?<ul>{view.history.map((item,index)=><li key={index}>{item.subject} · {day(item.startsAt)} · {label(item.state)}</li>)}</ul>:<p style={muted}>No meetings recorded.</p>}
  </section>
 </main>;
}
