import {type Client,type Context,fail} from './common.js';
import {DeliveryGateway,type DispatchCheck} from './integrations.js';
import {communicationDispatchChecks} from './communications.js';
import {assertContactable} from './crm.js';
import {assertCampaignDispatchable} from './campaigns.js';
import {assertDispatchAllowed} from './governance.js';

/**
 * The single composed outbound gate used by every production send path (owner console, Conversation Center,
 * sequences). Each check runs inside the dispatch transaction immediately before the approval is consumed,
 * after DeliveryGateway's built-in consent, suppression, cadence, sender, facts and budget gates.
 */
export const crmContactabilityCheck:DispatchCheck=async({tx,ctx,message})=>{
 if(!message.campaign_id)return fail('CAMPAIGN_NOT_APPROVED',403);
 await assertContactable(tx,ctx,{contactId:message.contact_id,campaignId:message.campaign_id,channel:'email'});
};
export const campaignApprovalCheck:DispatchCheck=async({tx,ctx,message,now})=>{
 await assertCampaignDispatchable(tx,ctx,message.campaign_id,Number(message.approved_campaign_revision),now);
};
export const governanceCheck:DispatchCheck=async({tx,ctx,message,environment})=>{
 const free=environment.EMAIL_BILLING_MODE==='free',cost=Number(environment.EMAIL_COST_CENTS??0);
 await assertDispatchAllowed(tx,ctx,{campaignId:message.campaign_id,channel:'email',providerId:'resend',estimateCents:free?0:Math.max(0,Number.isSafeInteger(cost)?cost:0)});
};
export const productionDispatchChecks:readonly DispatchCheck[]=[governanceCheck,crmContactabilityCheck,campaignApprovalCheck,...communicationDispatchChecks];
export function productionDeliveryGateway(client:Client,ctx:Context,environment:Record<string,string|undefined>=process.env,transport:typeof fetch=fetch,clock:()=>Date=()=>new Date()){
 return new DeliveryGateway(client,ctx,environment,transport,clock,{beforeDispatch:productionDispatchChecks});
}
