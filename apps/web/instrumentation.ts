export async function register(){
 if(process.env.NEXT_RUNTIME==='nodejs'&&process.env.JOB_WORKER_ENABLED==='true'&&process.argv.includes('start')){
  const {startWorkerWakeups}=await import('./lib/worker-launcher');startWorkerWakeups();
 }
}
