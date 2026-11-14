import {database} from '../../../../lib/database';
import {OperationError,portfolioSummary,type Client} from '@dots/operations';
export const dynamic='force-dynamic';
// DOTS-159: read-only, aggregate portfolio summaries for Boardroom/Engine Room. Bearer token only; GET only.
const headers={'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff'};
export async function GET(request:Request){
 const connection=await database().connect();
 const client:Client={query:async(statement,values)=>{const result=await connection.query(statement,values?[...values]:undefined);if(statement==='BEGIN')await connection.query('SET LOCAL ROLE dots_runtime');return result;}};
 try{return Response.json(await portfolioSummary(client,request.headers.get('authorization')),{headers});}
 catch(error){if(error instanceof OperationError)return Response.json({error:error.code},{status:error.status,headers:{...headers,'WWW-Authenticate':'Bearer'}});return Response.json({error:'PORTFOLIO_UNAVAILABLE'},{status:503,headers});}
 finally{await connection.query('ROLLBACK').catch(()=>undefined);connection.release();}
}
export function POST(){return Response.json({error:'READ_ONLY'},{status:405,headers:{...headers,Allow:'GET'}});}
