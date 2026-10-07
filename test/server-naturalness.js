'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');
const { digest } = require('../lib/owners');
const { createEvidenceStore } = require('../lib/naturalness-evidence');
const ROOT = path.resolve(__dirname, '..');

async function main() {
  let externalReads = 0, writes = 0;
  const upstream = http.createServer((req,res) => {
    if (req.method !== 'GET') writes++;
    if (req.url.startsWith('/api/v1/evidence.json')) {
      externalReads++;
      res.setHeader('Content-Type','application/json');
      res.end(JSON.stringify({schemaVersion:1,source:'feddit-current-votes',generatedAt:new Date().toISOString(),items:[],coverage:{warnings:[]}}));
    } else { res.statusCode=404; res.end('{}'); }
  });
  await new Promise(resolve=>upstream.listen(0,'127.0.0.1',resolve));
  const temp = fs.mkdtempSync(path.join(os.tmpdir(),'feddit-naturalness-server-'));
  let child;
  try {
    const now = new Date().toISOString();
    fs.writeFileSync(path.join(temp,'owners.json'),JSON.stringify({version:2,owners:['admin','other'].map(id=>({
      id,accessHash:digest(id+'-capability'),recoveryHash:digest(id+'-recovery'),createdAt:now,
    }))}));
    fs.writeFileSync(path.join(temp,'profiles.json'),JSON.stringify({schemaVersion:26,settings:{paused:true},profiles:[
      {id:'system',botOrigin:'system',fedditUsername:'system_bot',enabled:false,dryRun:true,persona:'PRIVATE_PERSONA'},
      {id:'private',ownerId:'other',fedditUsername:'private_other_owner',enabled:false,dryRun:true},
    ]}));
    const evidence=createEvidenceStore({file:path.join(temp,'naturalness-evidence.json')});
    for (const [profileId,bot] of [['system','system_bot'],['private','private_other_owner']]) {
      evidence.record({id:profileId+':offered',opportunityId:profileId,profileId,bot,stage:'offered',mode:'live',at:now,
        items:[{key:'post:1',targetType:'post',targetId:1,source:'ordinary_post',scoreAtExposure:null}]});
    }
    const portProbe=http.createServer();
    await new Promise(resolve=>portProbe.listen(0,'127.0.0.1',resolve));
    const port=portProbe.address().port;
    await new Promise(resolve=>portProbe.close(resolve));
    child=spawn(process.execPath,['server.js'],{cwd:ROOT,windowsHide:true,stdio:['ignore','pipe','pipe'],env:{
      ...process.env,FEDDIT_BOT_DATA_DIR:temp,FEDDIT_BOT_HOST:'127.0.0.1',FEDDIT_BOT_PORT:String(port),
      FEDDIT_BOT_PLACEMENT:'hosted',FEDDIT_POPULATION_ADMIN_OWNER_IDS:'admin',
      FEDDIT_SITE_BASE:'http://127.0.0.1:'+upstream.address().port,
    }});
    let output='';
    await new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>reject(new Error('Server startup timed out: '+output)),15000);
      const append=chunk=>{output+=chunk; if(output.includes('Feddit bot control panel is up.')){clearTimeout(timer);resolve();}};
      child.stdout.on('data',append);child.stderr.on('data',append);
      child.once('exit',code=>{clearTimeout(timer);reject(new Error('Server exited '+code+': '+output));});
    });
    const url='http://127.0.0.1:'+port+'/api/naturalness';
    const before=fs.readFileSync(path.join(temp,'profiles.json'),'utf8');
    assert.equal((await fetch(url)).status,401,'anonymous cannot read hosted observer');
    assert.equal((await fetch(url,{headers:{'x-feddit-bot-owner':'other-capability'}})).status,404,'ordinary owner cannot read operator tool');
    assert.equal(externalReads,0,'unauthorised requests do not fetch evidence');
    const response=await fetch(url,{headers:{'x-feddit-bot-owner':'admin-capability'}});
    assert.equal(response.status,200);
    const text=await response.text();
    assert(!text.includes('private_other_owner'),'operator does not get unrelated private owner telemetry');
    assert(!text.includes('PRIVATE_PERSONA'),'personas never exported');
    assert(!text.includes('capability'),'credentials never exported');
    assert(text.includes('system_bot'),'system bot evidence is available to operator');
    assert.equal((await fetch(url,{method:'POST',headers:{'x-feddit-bot-owner':'admin-capability'}})).status,404,'no intervention route');
    assert.equal(writes,0,'no upstream writes');
    assert.equal(externalReads,1,'one bounded read');
    assert.equal(fs.readFileSync(path.join(temp,'profiles.json'),'utf8'),before,'no profile or scheduler mutation');
    console.log('PASS Naturalness server: real hosted auth boundary, owner isolation, read-only endpoint, no bot mutation');
  } finally {
    if(child && child.exitCode===null){const ended=new Promise(resolve=>child.once('exit',resolve));child.kill();await ended;}
    await new Promise(resolve=>upstream.close(resolve));
    fs.rmSync(temp,{recursive:true,force:true});
  }
}
main().catch(error=>{console.error(error);process.exitCode=1;});
