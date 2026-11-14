import {verifyOptOut,CommunicationsWorkspace,OperationError} from '@dots/operations';
import {withOperations} from '../../../lib/operations';
export const dynamic='force-dynamic';
// DOTS-102: handles both the confirmation form on /unsubscribe and RFC 8058 one-click requests, where the mail
// client POSTs the body "List-Unsubscribe=One-Click" to the List-Unsubscribe URL with the signed token in the query.
export async function POST(request:Request){
 const url=new URL(request.url);let token=url.searchParams.get('token');let channel:'one_click'|'link'='link';
 if(request.headers.get('content-type')?.startsWith('application/x-www-form-urlencoded')){const raw=(await request.text()).slice(0,4000);const params=new URLSearchParams(raw);if(raw.trim()==='List-Unsubscribe=One-Click'||params.get('List-Unsubscribe')==='One-Click')channel='one_click';if(!token)token=params.get('token')??'';}
 const value=verifyOptOut(token??'',process.env.UNSUBSCRIBE_SIGNING_KEY);if(!value||value.org!==process.env.OWNER_ORGANIZATION_ID)return Response.json({error:'Invalid unsubscribe link'},{status:400});
 try{await withOperations((client,ctx)=>new CommunicationsWorkspace(client,ctx).processOptOut(value.contact,channel,{via:'signed_unsubscribe_token'}));}
 catch(error){if(!(error instanceof OperationError&&error.code==='NOT_FOUND'))return Response.json({error:'Unsubscribe temporarily unavailable. Please retry.'},{status:503,headers:{'Cache-Control':'no-store'}});}
 return new Response('You have been unsubscribed. No further campaign messages will be sent.',{headers:{'Content-Type':'text/plain; charset=utf-8','Cache-Control':'no-store'}});
}
