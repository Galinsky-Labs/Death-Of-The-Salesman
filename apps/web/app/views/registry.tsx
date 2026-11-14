"use client";
// Maps navigation labels to the roadmap views. Labels already handled by OperationsConsole render
// these views beneath it; labels listed in `dedicatedViews` get their own navigation entry.
import type {ComponentType} from 'react';
import {PlatformView} from './platform-view';
import {StrategyLabView} from './strategy-lab-view';
import {GovernanceView} from './governance-view';
import {FundingView} from './funding-view';
import {ModelsView} from './models-view';
import {RevenueView} from './revenue-view';
import {RuntimeView} from './runtime-view';
import {CampaignStudioView} from './campaign-studio-view';
import {CrmView} from './crm-view';
const ContactsCrm=()=><CrmView section="contacts"/>;
const PipelineCrm=()=><CrmView section="pipeline"/>;
const BudgetGovernance=()=><GovernanceView section="budget"/>;
const ApprovalGovernance=()=><GovernanceView section="approvals"/>;
const SafetyGovernance=()=><GovernanceView section="safety"/>;
export const dedicatedViews=["Campaign Studio","Models","Safety","Operations health"];
export const roadmapViews:Record<string,ComponentType[]>={
 "Operations health":[PlatformView],
 "Strategy Lab":[StrategyLabView],
 "Funding":[FundingView],
 "Models":[ModelsView],
 "Revenue":[RevenueView],
 "Campaign Studio":[CampaignStudioView],
 "Contacts":[ContactsCrm],
 "Pipeline":[PipelineCrm],
 "Work queue":[RuntimeView],
 "Agents":[RuntimeView],
 "Budget":[BudgetGovernance],
 "Approvals":[ApprovalGovernance],
 "Safety":[SafetyGovernance],
};
