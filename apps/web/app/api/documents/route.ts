import {ownerSession} from '../../../lib/auth';
import {withOperations,repositories} from '../../../lib/operations';
import {identifier} from '@dots/operations';
export const dynamic='force-dynamic';
export async function GET(request:Request){if(!await ownerSession())return Response.json({error:'Unauthorized'},{status:401});try{const id=identifier(new URL(request.url).searchParams.get('id'));const document=await withOperations((client,ctx)=>repositories(client,ctx).documents.read(id));return new Response(document.content,{headers:{'Content-Type':`${document.contentType}; charset=utf-8`,'Content-Disposition':`attachment; filename="document-${id}.txt"`,'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff'}});}catch{return Response.json({error:'Document unavailable'},{status:404});}}
