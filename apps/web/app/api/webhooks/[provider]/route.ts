import {verifyWebhook,verifySvix,OperationError,communicationsGateway,CommunicationsWorkspace} from '@dots/operations';
import {withOperations,repositories} from '../../../../lib/operations';
export const dynamic='force-dynamic';
// Signatures are verified (with a 300-second replay window) before any parsing or database work. Event ids are
// stored in provider_receipts so redelivery is idempotent and a changed payload under a known id is rejected.
// - stripe: Stripe-Signature HMAC          - resend: Svix signature (EMAIL_WEBHOOK_SECRET)
// - mail:   generic signed mailbox events (X-Mail-Signature "t=<unix>,v1=<hex hmac>", MAIL_WEBHOOK_SECRET), DOTS-095
export async function POST(request:Request,context:{params:Promise<{provider:string}>}){const {provider}=await context.params;const raw=await request.text();if(raw.length>262144)return Response.json({error:'Too large'},{status:413});try{
 const valid=provider==='stripe'?verifyWebhook(raw,request.headers.get('stripe-signature'),process.env.STRIPE_WEBHOOK_SECRET):provider==='resend'?verifySvix(raw,{id:request.headers.get('svix-id'),timestamp:request.headers.get('svix-timestamp'),signature:request.headers.get('svix-signature')},process.env.EMAIL_WEBHOOK_SECRET):provider==='mail'?verifyWebhook(raw,request.headers.get('x-mail-signature'),process.env.MAIL_WEBHOOK_SECRET):false;
 if(!valid)return Response.json({error:'Invalid signature'},{status:401});const payload=JSON.parse(raw);const eventId=provider==='stripe'||provider==='mail'?payload.id:request.headers.get('svix-id');if(typeof eventId!=='string'||eventId.length>240)return Response.json({error:'Invalid event'},{status:400});
 const result=await withOperations<unknown>((client,ctx)=>provider==='stripe'?repositories(client,ctx).payments.ingestStripe(eventId,payload):provider==='mail'?new CommunicationsWorkspace(client,ctx).ingestSignedEvent(eventId,payload):communicationsGateway(client,ctx).ingestEmail(eventId,payload));return Response.json(result);
 }catch(error){return Response.json({error:error instanceof OperationError?error.code:'Webhook rejected'},{status:error instanceof OperationError?error.status:400});}}
