// DOTS-158: provision an empty commercial tenant with an administrative connection. Disabled until the owner
// sets COMMERCIAL_SIGNUP_ENABLED=true after deciding to commercialize (terms, privacy, billing obligations).
// Usage: ADMIN_DATABASE_URL=… COMMERCIAL_SIGNUP_ENABLED=true node scripts/provision-tenant.mjs <slug> "<name>" <owner-subject> "<owner name>"
import {createRequire} from 'node:module';
if(process.env.COMMERCIAL_SIGNUP_ENABLED!=='true'){console.error('COMMERCIAL_ONBOARDING_NOT_AUTHORIZED');process.exit(2);}
if(!process.env.ADMIN_DATABASE_URL){console.error('ADMIN_DATABASE_URL is required');process.exit(2);}
const {Pool,neonConfig}=await import(createRequire(new URL('../packages/worker/package.json',import.meta.url)).resolve('@neondatabase/serverless'));
const {provisionTenant}=await import('../packages/operations/dist/index.js');
const [slug,displayName,ownerSubject,ownerName]=process.argv.slice(2);neonConfig.webSocketConstructor=WebSocket;
const pool=new Pool({connectionString:process.env.ADMIN_DATABASE_URL,max:1});const connection=await pool.connect();
try{console.log(JSON.stringify(await provisionTenant({query:(s,v)=>connection.query(s,v?[...v]:undefined)},{slug,displayName,ownerSubject,ownerName})));}
finally{connection.release();await pool.end();}
