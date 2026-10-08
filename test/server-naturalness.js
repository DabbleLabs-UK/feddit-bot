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

// Loaded only by this fixture's child process; production has no test switch.
function installProviderFixture({ root, log, upstream }) {
  const fs = require('node:fs');
  const providers = require(require('node:path').join(root, 'lib/providers'));
  const actualFetch = global.fetch;
  global.fetch = (url, options) => {
    if (new URL(String(url)).origin !== upstream) throw new Error('Fixture forbids external network calls');
    return actualFetch(url, options);
  };
  providers.status = async id => ({ id, state: id === 'chatgpt-plan' ? 'ready' : 'unavailable',
    label: 'Fixture subscription', creator: { eligible: true, autoPreferred: true, preference: 300 },
    models: [{ id: 'fixture-account-model' }] });
  providers.generate = async request => {
    if (request.requestKind !== 'naturalness-review') throw new Error('Unexpected generation outside review');
    const calls = JSON.parse(fs.readFileSync(log, 'utf8'));
    calls.push({ provider: request.provider, model: request.model, prompt: request.prompt, system: request.system });
    fs.writeFileSync(log, JSON.stringify(calls));
    return { text: JSON.stringify({ patterns: [], proposal: {
      problem: 'The sample is limited.', hypothesis: 'More evidence could clarify it.', smallestChange: 'Continue observation only.',
      expectedEffect: 'More observations.', risks: ['Sampling remains incomplete.'], measurements: ['Compare matched windows.'],
      rollback: 'Stop extra observation.', evidenceIds: [],
      changes: { scheduler: false, prompt: false, ecologyPolicy: false, exposure: false, socialState: false, persona: false },
    } }) };
  };
}

async function main() {
  let externalReads = 0, publicReads = 0, writes = 0, publicVersion = 1;
  const upstream = http.createServer((req,res) => {
    if (req.method !== 'GET') writes++;
    if (req.url.startsWith('/api/v1/evidence.json')) {
      externalReads++;
      res.setHeader('Content-Type','application/json');
      res.end(JSON.stringify({schemaVersion:1,source:'feddit-current-votes',generatedAt:new Date().toISOString(),items:[],coverage:{warnings:[]}}));
    } else if (req.url.startsWith('/api/v1/front/new')) {
      publicReads++;
      res.setHeader('Content-Type','application/json');
      res.end(JSON.stringify({kind:'Listing',data:{after:null,children:[{kind:'t3',data:{
        id:101,author:'public_bot',feddit:'fixture',title:'SERVER_PUBLIC_ITEM_'+publicVersion,
        selftext:'Public server evidence only.',created_utc:Math.floor(Date.now()/1000)-60,num_comments:0,kind:'text',over_18:false,
      }}]}}));
    } else if (req.url === '/api/v1/feddits') {
      publicReads++;
      res.setHeader('Content-Type','application/json');
      res.end(JSON.stringify({feddits:[{name:'fixture',description:'Public fixture discussion.',rules:[],over_18:false}]}));
    } else { res.statusCode=404; res.end('{}'); }
  });
  await new Promise(resolve=>upstream.listen(0,'127.0.0.1',resolve));
  const temp = fs.mkdtempSync(path.join(os.tmpdir(),'feddit-naturalness-server-'));
  let child;
  try {
    const now = new Date().toISOString();
    fs.writeFileSync(path.join(temp,'owners.json'),JSON.stringify({version:2,owners:['admin','admin2','other'].map(id=>({
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
    const providerLog=path.join(temp,'provider-calls.json');
    fs.writeFileSync(providerLog,'[]');
    const preload=path.join(temp,'provider-preload.js');
    fs.writeFileSync(preload,'('+installProviderFixture.toString()+')('+JSON.stringify({
      root:ROOT,log:providerLog,upstream:'http://127.0.0.1:'+upstream.address().port,
    })+');');
    child=spawn(process.execPath,['--require',preload,'server.js'],{cwd:ROOT,windowsHide:true,stdio:['ignore','pipe','pipe'],env:{
      ...process.env,FEDDIT_BOT_DATA_DIR:temp,FEDDIT_BOT_HOST:'127.0.0.1',FEDDIT_BOT_PORT:String(port),
      FEDDIT_BOT_PLACEMENT:'hosted',FEDDIT_POPULATION_ADMIN_OWNER_IDS:'admin,admin2',
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
    for (const [route,method] of [['/reviewer','GET'],['/reviews','GET'],['/reviews','POST']]) {
      assert.equal((await fetch(url+route,{method})).status,401,'anonymous denied on '+method+' '+route);
      assert.equal((await fetch(url+route,{method,headers:{'x-feddit-bot-owner':'other-capability'}})).status,404,'non-admin denied on '+method+' '+route);
    }
    assert.equal(publicReads,0,'unauthorised review requests do not collect public ecology');
    const response=await fetch(url,{headers:{'x-feddit-bot-owner':'admin-capability'}});
    assert.equal(response.status,200);
    const text=await response.text();
    assert(!text.includes('private_other_owner'),'operator does not get unrelated private owner telemetry');
    assert(!text.includes('PRIVATE_PERSONA'),'personas never exported');
    assert(!text.includes('capability'),'credentials never exported');
    assert(text.includes('system_bot'),'system bot evidence is available to operator');
    assert(text.includes('SERVER_PUBLIC_ITEM_1'),'GET collects the current public sample');
    assert.equal((await fetch(url,{method:'POST',headers:{'x-feddit-bot-owner':'admin-capability'}})).status,404,'no intervention route');
    assert.equal(writes,0,'no upstream writes');
    assert.equal(externalReads,1,'one bounded read');
    const adminHeaders={'x-feddit-bot-owner':'admin-capability'};
    const jsonHeaders={...adminHeaders,'content-type':'application/json'};
    const calls=()=>JSON.parse(fs.readFileSync(providerLog,'utf8'));
    assert.equal((await fetch(url+'/reviewer',{headers:adminHeaders})).status,200);
    assert.deepEqual((await (await fetch(url+'/reviews',{headers:adminHeaders})).json()).reviews,[]);
    assert.equal(calls().length,0,'snapshot, readiness and history GET never generate');
    for (const confirm of [undefined,false,'true',1]) {
      assert.equal((await fetch(url+'/reviews',{method:'POST',headers:jsonHeaders,body:JSON.stringify({confirm})})).status,400,'confirmation must be explicit boolean true');
    }
    assert.equal((await fetch(url+'/reviews',{method:'POST',headers:{...adminHeaders,'content-type':'text/plain'},body:'{"confirm":true}'})).status,415);
    assert.equal((await fetch(url+'/reviews',{method:'POST',headers:{...jsonHeaders,'sec-fetch-site':'cross-site'},body:'{"confirm":true}'})).status,403);
    assert.equal((await fetch(url+'/reviews',{method:'POST',headers:{...jsonHeaders,origin:'https://foreign.example'},body:'{"confirm":true}'})).status,403);
    assert.equal(calls().length,0,'rejected review requests never generate');
    const publicReadsBefore=publicReads;
    publicVersion=2;
    const confirmed=await fetch(url+'/reviews',{method:'POST',headers:jsonHeaders,body:JSON.stringify({
      confirm:true,hours:24,prompt:'FORGED_PROMPT',system:'FORGED_SYSTEM',provider:'FORGED_PROVIDER',model:'FORGED_MODEL',
      ecology:{examples:[{title:'FORGED_ECOLOGY'}]},votingSnapshot:{items:[{title:'FORGED_VOTES'}]},
    })});
    assert.equal(confirmed.status,200);
    const first=(await confirmed.json()).review;
    assert.equal(first.status,'completed');
    assert.equal(calls().length,1,'one confirmed action makes one provider call');
    assert(publicReads>publicReadsBefore,'confirmed action reconstructs current public evidence');
    assert.equal(calls()[0].provider,'chatgpt-plan');
    assert.equal(calls()[0].model,'fixture-account-model');
    assert(calls()[0].prompt.includes('SERVER_PUBLIC_ITEM_2'),'generation gets current server evidence');
    assert(!calls()[0].prompt.includes('SERVER_PUBLIC_ITEM_1'),'generation does not reuse the earlier GET sample');
    assert.doesNotMatch(JSON.stringify(calls()[0]),/FORGED_|PRIVATE_PERSONA|private_other_owner/);
    assert.doesNotMatch(JSON.stringify(first),/FORGED_|PRIVATE_PERSONA|private_other_owner/);
    const admin2Headers={'x-feddit-bot-owner':'admin2-capability'};
    assert.deepEqual((await (await fetch(url+'/reviews',{headers:admin2Headers})).json()).reviews,[],'another admin does not inherit review history');
    const secondResponse=await fetch(url+'/reviews',{method:'POST',headers:{...admin2Headers,'content-type':'application/json'},body:'{"confirm":true}'});
    assert.equal(secondResponse.status,200);
    const second=(await secondResponse.json()).review;
    assert.equal(second.status,'completed');
    assert.notEqual(second.id,first.id);
    const firstHistory=(await (await fetch(url+'/reviews',{headers:adminHeaders})).json()).reviews;
    const secondHistory=(await (await fetch(url+'/reviews',{headers:admin2Headers})).json()).reviews;
    assert.deepEqual(firstHistory.map(review=>review.id),[first.id]);
    assert.deepEqual(secondHistory.map(review=>review.id),[second.id]);
    const secondSnapshot=await (await fetch(url,{headers:admin2Headers})).json();
    assert.deepEqual(secondSnapshot.reviews.map(review=>review.id),[second.id],'snapshot history is scoped too');
    assert.equal(calls().length,2,'history and snapshot GET never rerun completed reviews');
    assert.equal(writes,0,'reviewing never makes upstream writes');
    assert.equal(fs.readFileSync(path.join(temp,'profiles.json'),'utf8'),before,'no profile or scheduler mutation');
    console.log('PASS Naturalness server: hosted route auth, explicit review guards, server-owned evidence, admin-scoped history, no bot mutation');
  } finally {
    if(child && child.exitCode===null){const ended=new Promise(resolve=>child.once('exit',resolve));child.kill();await ended;}
    await new Promise(resolve=>upstream.close(resolve));
    fs.rmSync(temp,{recursive:true,force:true});
  }
}
main().catch(error=>{console.error(error);process.exitCode=1;});
