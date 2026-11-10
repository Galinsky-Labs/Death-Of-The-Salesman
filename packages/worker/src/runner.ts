import {Pool,neonConfig} from '@neondatabase/serverless';
import {runOneTask,DeliveryGateway,type Client,type Context} from '@dots/operations';
import {randomUUID} from 'node:crypto';
neonConfig.webSocketConstructor=WebSocket;
const workerId=`worker-${randomUUID()}`;
let stopping=false;process.once('SIGTERM',()=>{stopping=true;});process.once('SIGINT',()=>{stopping=true;});
async function main(){
 if(process.env.JOB_WORKER_ENABLED!=='true'||!process.env.DATABASE_URL||!process.env.OWNER_ORGANIZATION_ID||!process.env.OWNER_MEMBERSHIP_ID)return;
 const pool=new Pool({connectionString:process.env.DATABASE_URL,max:1,connectionTimeoutMillis:10000});
 const connection=await pool.connect();const ctx:Context={organizationId:process.env.OWNER_ORGANIZATION_ID,membershipId:process.env.OWNER_MEMBERSHIP_ID};
 const client:Client={query:async(statement,values)=>{const result=await connection.query(statement,values?[...values]:undefined);if(statement==='BEGIN')await connection.query('SET LOCAL ROLE dots_runtime');return result;}};
 try{for(let count=0;count<10&&!stopping;count++){const result=await runOneTask(client,ctx,workerId);if(!result)break;console.log(JSON.stringify({event:'worker.task_finished',taskId:result.taskId,state:result.state}));}
 const pending=await connection.query("BEGIN; SET LOCAL ROLE dots_runtime;");
 await connection.query("SELECT set_config('app.organization_id',$1,true)",[ctx.organizationId]);
 const receipts=await connection.query("SELECT event_id,normalized_event FROM app.provider_receipts WHERE organization_id=$1 AND provider='resend' AND processed_at IS NULL ORDER BY received_at DESC LIMIT 10",[ctx.organizationId]);await connection.query('COMMIT');
 for(const receipt of receipts.rows)if(!stopping)await new DeliveryGateway(client,ctx).ingestEmail(receipt.event_id,receipt.normalized_event,true);
 }finally{await connection.query('ROLLBACK').catch(()=>undefined);connection.release();await pool.end();}
}
main().catch(error=>{console.error(JSON.stringify({event:'worker.failed',code:typeof error?.code==='string'?error.code:'WORKER_ERROR'}));process.exitCode=1;});
