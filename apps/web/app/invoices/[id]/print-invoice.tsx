"use client";
export function PrintInvoice(){return <div className="invoice-print-controls" style={{display:'flex',gap:20,marginTop:35}}><button onClick={()=>window.print()} style={{padding:'12px 20px',cursor:'pointer'}}>Print / save as PDF</button><a href="/dashboard">Back to workspace</a></div>;}
