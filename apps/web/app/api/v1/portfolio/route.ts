import type {PoolClient} from '@neondatabase/serverless';
import {database} from '../../../../lib/database';
import {OperationError,portfolioBearer,portfolioSummary,type Client} from '@dots/operations';
export const dynamic='force-dynamic';
// DOTS-159: read-only, aggregate portfolio summaries for Boardroom/Engine Room. Bearer token only; GET only.
const headers={'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff'};
const rejected=(error:OperationError)=>Response.json({error:error.code},{status:error.status,headers:{...headers,'WWW-Authenticate':'Bearer'}});
const unavailable=()=>Response.json({error:'PORTFOLIO_UNAVAILABLE'},{status:503,headers});
export async function GET(request:Request){
 const authorization=request.headers.get('authorization');
 // Reject anonymous or malformed tokens before opening a connection: scanners must not wake the database.
 try{portfolioBearer(authorization);}catch(error){if(error instanceof OperationError)return rejected(error);return unavailable();}
 let connection:PoolClient;
 try{connection=await database().connect();}catch{return unavailable();}
 const client:Client={query:async(statement,values)=>{const result=await connection.query(statement,values?[...values]:undefined);if(statement==='BEGIN')await connection.query('SET LOCAL ROLE dots_runtime');return result;}};
 try{return Response.json(await portfolioSummary(client,authorization),{headers});}
 catch(error){if(error instanceof OperationError)return rejected(error);return unavailable();}
 finally{await connection.query('ROLLBACK').catch(()=>undefined);connection.release();}
}
export function POST(){return Response.json({error:'READ_ONLY'},{status:405,headers:{...headers,Allow:'GET'}});}
