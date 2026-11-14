"use client";
// Maps navigation labels to the roadmap views. Labels already handled by OperationsConsole render
// these views beneath it; labels listed in `dedicatedViews` get their own navigation entry.
import type {ComponentType} from 'react';
import {PlatformView} from './platform-view';
export const dedicatedViews=["Operations health"];
export const roadmapViews:Record<string,ComponentType[]>={
 "Operations health":[PlatformView],
};
