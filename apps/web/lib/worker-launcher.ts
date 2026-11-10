import {spawn,type ChildProcess} from 'node:child_process';
import {resolve,dirname} from 'node:path';
import {existsSync} from 'node:fs';
const state=(globalThis as typeof globalThis & {dotsWorker?:{worker?:ChildProcess;timer?:ReturnType<typeof setInterval>}});
state.dotsWorker??={};
export function wakeWorker(){
 if(process.env.JOB_WORKER_ENABLED!=='true'||state.dotsWorker!.worker)return;
 let root=process.cwd();while(!existsSync(resolve(root,'packages/worker/dist/runner.js'))&&dirname(root)!==root)root=dirname(root);
 const worker=spawn(process.execPath,[resolve(root,'packages/worker/dist/runner.js')],{stdio:['ignore','inherit','inherit'],env:process.env});state.dotsWorker!.worker=worker;
 worker.once('exit',()=>{state.dotsWorker!.worker=undefined;});worker.once('error',()=>{state.dotsWorker!.worker=undefined;});
}
export function startWorkerWakeups(){if(state.dotsWorker!.timer)return;wakeWorker();const timer=setInterval(wakeWorker,60000);state.dotsWorker!.timer=timer;timer.unref();process.once('SIGTERM',()=>{clearInterval(timer);state.dotsWorker!.worker?.kill('SIGTERM');});}
