"use client";
// Maps navigation labels to the roadmap views. Labels already handled by OperationsConsole render
// these views beneath it; labels listed in `dedicatedViews` get their own navigation entry.
import type {ComponentType} from 'react';
import {PlatformView} from './platform-view';
import {StrategyLabView} from './strategy-lab-view';
import {GovernanceView} from './governance-view';
import {FundingView} from './funding-view';
import {ModelsView} from './models-view';
const BudgetGovernance=()=><GovernanceView section="budget"/>;
const ApprovalGovernance=()=><GovernanceView section="approvals"/>;
const SafetyGovernance=()=><GovernanceView section="safety"/>;
export const dedicatedViews=["Models","Safety","Operations health"];
export const roadmapViews:Record<string,ComponentType[]>={
 "Operations health":[PlatformView],
 "Strategy Lab":[StrategyLabView],
 "Funding":[FundingView],
 "Models":[ModelsView],
 "Budget":[BudgetGovernance],
 "Approvals":[ApprovalGovernance],
 "Safety":[SafetyGovernance],
};
