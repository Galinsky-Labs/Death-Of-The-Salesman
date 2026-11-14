// DOTS-141 public website lead form endpoint. Intentionally does NOT require an owner session.
// GET ?form=<key> returns consent text/version and a signed single-use nonce; POST submits the lead.
// Responses never echo stored data and never reveal whether a contact already exists. Submissions never trigger outreach.
import {OperationError,RevenueOperations} from '@dots/operations';
import {withOperations} from '../../../../lib/operations';
export const dynamic='force-dynamic';
const base:Record<string,string>={'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer'};
const safeCodes=new Set(['FORM_UNAVAILABLE','ORIGIN_NOT_ALLOWED','RATE_LIMITED','INVALID_SUBMISSION','SUBMISSION_REPLAYED','CONSENT_REQUIRED','CONSENT_VERSION_MISMATCH','INVALID_NAME','INVALID_EMAIL','INVALID_MESSAGE','LEAD_FORM_NOT_CONFIGURED']);
function cors(request:Request):Record<string,string>{const origin=request.headers.get('origin');return origin&&/^https:\/\/[a-z0-9.-]+(:[0-9]+)?$/i.test(origin)?{'Access-Control-Allow-Origin':origin,Vary:'Origin'}:{};}
function failure(request:Request,error:unknown){const code=error instanceof OperationError&&safeCodes.has(error.code)?error.code:'SUBMISSION_REJECTED';const status=error instanceof OperationError&&safeCodes.has(error.code)?error.status:400;
 return Response.json({error:code},{status,headers:{...base,...cors(request),...(code==='RATE_LIMITED'?{'Retry-After':'86400'}:{})} as Record<string,string>});}
/** The right-most X-Forwarded-For entry is the one appended by the hosting proxy; it is only ever stored as a keyed hash. */
function clientIp(request:Request){const forwarded=request.headers.get('x-forwarded-for')?.split(',').map(part=>part.trim()).filter(Boolean)??[];return forwarded.at(-1)??request.headers.get('x-real-ip')??'unknown';}
export async function OPTIONS(request:Request){return new Response(null,{status:204,headers:{...base,...cors(request),'Access-Control-Allow-Methods':'GET, POST','Access-Control-Allow-Headers':'content-type','Access-Control-Max-Age':'600'}});}
export async function GET(request:Request){try{const form=new URL(request.url).searchParams.get('form');
 const challenge=await withOperations((client,ctx)=>new RevenueOperations(client,ctx).leadFormChallenge(form));return Response.json(challenge,{headers:{...base,...cors(request)}});}catch(error){return failure(request,error);}}
export async function POST(request:Request){try{
 const type=request.headers.get('content-type')??'';const raw=await request.text();if(raw.length>8192)throw new OperationError('INVALID_SUBMISSION',413);
 let fields:Record<string,unknown>;
 if(type.startsWith('application/json')){const parsed=JSON.parse(raw);if(!parsed||typeof parsed!=='object'||Array.isArray(parsed))throw new OperationError('INVALID_SUBMISSION',400);fields=parsed;}
 else if(type.startsWith('application/x-www-form-urlencoded'))fields=Object.fromEntries(new URLSearchParams(raw));
 else throw new OperationError('INVALID_SUBMISSION',415);
 const result=await withOperations((client,ctx)=>new RevenueOperations(client,ctx).submitLead({formKey:fields.form,nonce:fields.nonce,honeypot:fields.website,name:fields.name,email:fields.email,message:fields.message,consent:fields.consent,consentVersion:fields.consentVersion,
  ip:clientIp(request),origin:request.headers.get('origin'),pageUrl:fields.pageUrl??request.headers.get('referer'),userAgent:request.headers.get('user-agent')}));
 return Response.json(result,{status:202,headers:{...base,...cors(request)}});
 }catch(error){return failure(request,error);}}
