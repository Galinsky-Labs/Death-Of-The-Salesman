import {ownerSession} from '../../../lib/auth';
import {inWorkspace,tenant} from '../../../lib/database';
export const dynamic='force-dynamic';
const tables=['crm_accounts','crm_contacts','contact_suppressions','contact_events','deals','strategies','campaigns','campaign_revisions','campaign_audience','conversations','messages','experiments','experiment_enrollments','funding_opportunities','funding_checklist','invoices','money_entries','spending_policies','budget_reservations','task_queue','agent_runs','run_checkpoints','action_approvals','operation_events','document_library'];
const idless:Record<string,string>={contact_suppressions:'email_hash',campaign_revisions:'campaign_id,revision',campaign_audience:'campaign_id,contact_id',experiment_enrollments:'experiment_id,contact_id'};
const csv=(value:unknown)=>{let text=String(value??'');if(/^[=+@\t\r-]/.test(text))text=`'${text}`;return `"${text.replaceAll('"','""')}"`;};
export async function GET(request:Request){if(!await ownerSession())return Response.json({error:'Unauthorized'},{status:401});const resource=new URL(request.url).searchParams.get('resource');if(!['contacts','workspace'].includes(resource??''))return Response.json({error:'Invalid export'},{status:400});
 const encoder=new TextEncoder();let offset=0,index=0,opened=false,first=true,started=false;
 const stream=new ReadableStream<Uint8Array>({async pull(controller){try{
  if(resource==='contacts'){
   if(!started){controller.enqueue(encoder.encode('name,email,status,consent,lawful_source,jurisdiction\r\n'));started=true;return;}
   const rows=await inWorkspace(async client=>(await client.query('SELECT display_name,email,status,consent,lawful_source,jurisdiction FROM app.crm_contacts WHERE organization_id=$1 ORDER BY id LIMIT 500 OFFSET $2',[tenant().organizationId,offset])).rows);if(!rows.length){controller.close();return;}offset+=rows.length;controller.enqueue(encoder.encode(rows.map(row=>[row.display_name,row.email,row.status,row.consent,row.lawful_source,row.jurisdiction].map(csv).join(',')).join('\r\n')+'\r\n'));return;
  }
  if(!started){controller.enqueue(encoder.encode(JSON.stringify({format:'dots-workspace-v1',exportedAt:new Date().toISOString()}).slice(0,-1)+',"tables":{'));started=true;return;}
  if(index>=tables.length){controller.enqueue(encoder.encode('}}'));controller.close();return;}
  const table=tables[index]!;
  if(!opened){controller.enqueue(encoder.encode(`${index?',':''}${JSON.stringify(table)}:[`));opened=true;first=true;offset=0;return;}
  const limit=table==='document_library'?5:table==='messages'?100:500;
  const result=await inWorkspace(async client=>(await client.query(`SELECT * FROM app.${table} WHERE organization_id=$1 ORDER BY ${idless[table]??'id'} LIMIT ${limit} OFFSET $2`,[tenant().organizationId,offset])).rows);
  if(!result.length){controller.enqueue(encoder.encode(']'));index++;opened=false;return;}
  controller.enqueue(encoder.encode(`${first?'':','}${result.map(row=>JSON.stringify(row)).join(',')}`));first=false;offset+=result.length;
 }catch{controller.error(new Error('Export interrupted; retry while signed in.'));}}});
 return new Response(stream,{headers:{'Content-Type':resource==='contacts'?'text/csv; charset=utf-8':'application/json','Content-Disposition':`attachment; filename="salesroom-${resource}.${resource==='contacts'?'csv':'json'}"`,'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff'}});
}
