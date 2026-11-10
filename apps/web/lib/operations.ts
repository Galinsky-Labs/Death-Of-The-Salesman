import {database,inWorkspace,tenant as workspaceTenant} from './database';
import {ControlPlane,SalesWorkspace,GrowthWorkspace,DocumentLibrary,DeliveryGateway,PaymentGateway,DurableQueue,providerConfiguration,providerIds,type Client,type Context} from '@dots/operations';
export type DataRow=Record<string,any>;
export type OperationsSnapshot={records:Record<string,DataRow[]>;totals:Record<string,number>;summary:DataRow;providers:DataRow[];capabilities:DataRow;observedAt:string};
export function context():Context{const owner=workspaceTenant();return {organizationId:owner.organizationId,membershipId:owner.ownerMembershipId};}
export async function withOperations<T>(fn:(client:Client,ctx:Context)=>Promise<T>){const connection=await database().connect();const client:Client={query:async(statement,values)=>{const result=await connection.query(statement,values?[...values]:undefined);if(statement==='BEGIN')await connection.query('SET LOCAL ROLE dots_runtime');return result;}};try{return await fn(client,context());}finally{await connection.query('ROLLBACK').catch(()=>undefined);connection.release();}}
const sources:Record<string,{table:string;columns?:string;order?:string}>={
 accounts:{table:'crm_accounts'},contacts:{table:'crm_contacts'},deals:{table:'deals'},campaigns:{table:'campaigns'},strategies:{table:'strategies'},experiments:{table:'experiments'},funding:{table:'funding_opportunities'},checklist:{table:'funding_checklist',order:'id'},invoices:{table:'invoices'},conversations:{table:'conversations',order:'updated_at DESC'},messages:{table:'messages'},jobs:{table:'task_queue',columns:"*,(state='running' AND lease_expires_at>app.utc_now() AND heartbeat_at>app.utc_now()-interval '20 seconds') AS lease_is_live"},runs:{table:'agent_runs',order:'started_at DESC'},approvals:{table:'action_approvals'},budgets:{table:'spending_policies',order:'id'},reservations:{table:'budget_reservations'},ledger:{table:'money_entries',order:'occurred_at DESC'},documents:{table:'document_library',columns:'id,project_id,title,content_type,content_hash,rights_basis,version,created_at'},events:{table:'operation_events',order:'occurred_at DESC'},mailboxes:{table:'mailboxes'},offers:{table:'offers'},facts:{table:'vetted_product_facts'},controls:{table:'policy_controls',order:'updated_at DESC'},audience:{table:'campaign_audience',order:'campaign_id'},agentConfig:{table:'agent_configuration',order:'agent_identity_id'},
};
export async function loadOperations(options:{section?:string;page?:number;query?:string;conversation?:string}={}):Promise<OperationsSnapshot>{return inWorkspace(async client=>{
 const page=Number.isSafeInteger(options.page)&&Number(options.page)>=0?Math.min(100000,Number(options.page)):0;
 const values=[workspaceTenant().organizationId,options.query?`%${options.query.slice(0,100)}%`:null,options.conversation??null];
 const recordParts:string[]=[],countParts:string[]=[];
 for(const [name,source] of Object.entries(sources)){
  const conditions=['organization_id=$1'];
  if(name==='contacts')conditions.push('($2::text IS NULL OR display_name ILIKE $2 OR email ILIKE $2)');
  if(name==='messages')conditions.push('($3::uuid IS NULL OR conversation_id=$3::uuid)');
  const where=conditions.join(' AND '),offset=options.section===name?page*50:0;
  recordParts.push(`'${name}',COALESCE((SELECT jsonb_agg(to_jsonb(item)) FROM(SELECT ${source.columns??'*'} FROM app.${source.table} WHERE ${where} ORDER BY ${source.order??'created_at DESC'} LIMIT ${name==='audience'?10000:50} OFFSET ${offset}) AS item),'[]'::jsonb)`);
  countParts.push(`'${name}',(SELECT count(*)::int FROM app.${source.table} WHERE ${where})`);
 }
 const snapshot=await client.query(`SELECT jsonb_build_object(${recordParts.join(',')}) AS records,jsonb_build_object(${countParts.join(',')}) AS totals,
 (SELECT jsonb_build_object('received_sales_cents',COALESCE(sum(amount_cents) FILTER(WHERE kind='sale_receipt' AND source='provider'),0)::text,
 'received_funding_cents',COALESCE(sum(amount_cents) FILTER(WHERE kind IN ('grant_disbursement','investment_receipt') AND source='provider'),0)::text,
 'refunds_cents',COALESCE(sum(amount_cents) FILTER(WHERE kind='refund' AND source='provider'),0)::text,
 'costs_cents',COALESCE(sum(amount_cents) FILTER(WHERE kind='expense' AND source='provider'),0)::text,
 'sandbox_sales_cents',COALESCE(sum(amount_cents) FILTER(WHERE kind='sale_receipt' AND source='simulation'),0)::text) FROM app.money_entries WHERE organization_id=$1) AS revenue,
 (SELECT COALESCE(sum(value_cents) FILTER(WHERE stage NOT IN ('won','lost')),0)::text FROM app.deals WHERE organization_id=$1) AS pipeline_cents`,values);
 const snapshotRow=snapshot.rows[0]!;
 const records=snapshotRow.records as Record<string,DataRow[]>,totals=snapshotRow.totals as Record<string,number>;
 const providers=providerIds.map(id=>{try{const config=providerConfiguration(id);return {id,configured:Boolean(config),model:config?.model??null,state:config?'configured':'not_connected',inputCentsPerMillion:config?.inputCentsPerMillion??null,outputCentsPerMillion:config?.outputCentsPerMillion??null};}catch{return {id,configured:false,model:null,state:'configuration_invalid'};}});
 return {records,totals,summary:{...snapshotRow.revenue,pipeline_cents:snapshotRow.pipeline_cents},providers,capabilities:{workerEnabled:process.env.JOB_WORKER_ENABLED==='true',modelEnabled:process.env.MODEL_API_ENABLED==='true',emailEnabled:process.env.EMAIL_DELIVERY_ENABLED==='true',paymentsEnabled:process.env.PAYMENTS_ENABLED==='true',documentStorage:Boolean(process.env.DOCUMENT_ENCRYPTION_KEY),hardCapCents:Number(process.env.PAID_SPEND_LIMIT_CENTS??0),outreachPolicy:Boolean(process.env.OUTREACH_POLICY_AUTHORIZATION_ID),publicOrigin:process.env.APP_ORIGIN??null},observedAt:new Date().toISOString()};
 });}
export const repositories=(client:Client,ctx:Context)=>({control:new ControlPlane(client,ctx),sales:new SalesWorkspace(client,ctx),growth:new GrowthWorkspace(client,ctx),documents:new DocumentLibrary(client,ctx,process.env.DOCUMENT_ENCRYPTION_KEY),delivery:new DeliveryGateway(client,ctx),payments:new PaymentGateway(client,ctx),queue:new DurableQueue(client,ctx,'owner-control')});
