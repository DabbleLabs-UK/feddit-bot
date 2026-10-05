'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { digest } = require('../lib/owners');
let checks = 0;
function eq(a,b,m) { assert.deepEqual(a,b,m); checks++; }
async function port() { const s = net.createServer(); await new Promise((r) => s.listen(0,'127.0.0.1',r)); const p = s.address().port; await new Promise((r) => s.close(r)); return p; }
async function run(placement) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'feddit-groups-api-'));
  const apiPort = await port();
  const own = placement === 'hosted' ? 'a' : null;
  fs.writeFileSync(path.join(dir,'owners.json'), JSON.stringify({version:2,owners:['a','b'].map(id => ({id,accessHash:digest('token-'+id),createdAt:new Date().toISOString()}))}));
  fs.writeFileSync(path.join(dir,'profiles.json'), JSON.stringify({schemaVersion:26,settings:{paused:true},groups:[],profiles:[
    {id:'first',ownerId:own,enabled:false,dryRun:true,provider:'ollama',fedditUsername:'first',postsPerHour:0,commentsPerHour:0},
    {id:'other',ownerId:'b',enabled:false,dryRun:true,fedditUsername:'other'},
    {id:'population',ownerId:null,botOrigin:'system',enabled:false,dryRun:true,canReply:true,canStartDiscussions:true,canShareLinks:false,provider:'ollama',fedditUsername:'population',postsPerHour:0,commentsPerHour:0},
  ]}));
  const child = spawn(process.execPath,['server.js'],{cwd:path.resolve(__dirname,'..'),windowsHide:true,env:{...process.env,FEDDIT_BOT_DATA_DIR:dir,FEDDIT_BOT_PORT:String(apiPort),FEDDIT_BOT_PLACEMENT:placement,FEDDIT_POPULATION_ADMIN_OWNER_IDS:'a'}});
  let output=''; child.stdout.on('data',b=>output+=b); child.stderr.on('data',b=>output+=b);
  const request = async (route, method='GET', body, token='token-a') => {
    const res=await fetch('http://127.0.0.1:'+apiPort+route,{method,headers:{'Content-Type':'application/json','X-Feddit-Bot-Owner':token},...(body?{body:JSON.stringify(body)}:{})});
    return {status:res.status,data:await res.json()};
  };
  try {
    let ready=false;
    for(let i=0;i<100;i++){try{await request('/api/runtime');ready=true;break;}catch{await new Promise(r=>setTimeout(r,50));}}
    if(!ready)throw new Error(output);
    const created=await request('/api/groups','POST',{name:'Fixture',profileId:'first'});
    eq(created.status,201,'create group'); const id=created.data.group.id;
    eq((await request('/api/profiles/first/group','PUT',{groupId:id})).data.profile.groupId,id,'assign group');
    eq((await request('/api/groups/'+id,'PUT',{name:'Renamed'})).status,200,'rename group');
    if(placement==='hosted') {
      eq((await request('/api/groups', 'GET',undefined,'token-b')).data.groups.length,0,'other owner cannot see groups');
      eq((await request('/api/groups/'+id,'DELETE',undefined,'token-b')).status,404,'other owner cannot delete');
      eq((await request('/api/profiles/other/group','PUT',{groupId:id})).status,404,'cannot manage other owner profile');
      eq((await request('/api/profiles/population/group','PUT',{groupId:id})).status,400,'system ownership cannot cross to personal');
      eq((await request('/api/importer-profile-repair','POST',{sessionId:'none'})).status,404,'repair not hosted');
    }
    const forecast=await request('/api/activity-forecast');
    eq(forecast.status,200,'forecast endpoint runs');
    eq(forecast.data.filters.mode,'live','LIVE default');
    eq(forecast.data.paused,true,'paused state disclosed');
    eq(forecast.data.upcoming,[],'disabled profiles excluded');
    eq((await request('/api/profiles/first','PUT',{toneNotes:'edit',groupId:''})).data.profile.groupId,id,'dirty edit cannot undo membership');
    if(placement==='desktop') {
      const edited=await request('/api/profiles/population','PUT',{commentsPerHour:0.2});
      eq(edited.data.profile.populationCadenceMode,'custom','desktop population rate edit overrides ecology');
      eq(edited.data.profile.enabled,false,'rate edit does not activate');
    }
    eq((await request('/api/groups/'+id,'DELETE')).status,200,'delete group');
    const profiles=(await request('/api/profiles')).data.profiles;
    eq(profiles.find(p=>p.id==='first').groupId,'','delete leaves bot ungrouped');
    eq(profiles.find(p=>p.id==='first').enabled,false,'delete does not enable bot');
    eq(JSON.stringify(forecast.data).includes('token-a'),false,'forecast no credential leakage');
  } finally {
    child.kill(); await new Promise(r=>child.exitCode!==null?r():child.once('exit',r));
    fs.rmSync(dir,{recursive:true,force:true});
  }
}
(async()=>{await run('desktop');await run('hosted');console.log('Server groups/forecast: '+checks+' checks passed; fixture data only.');})().catch(e=>{console.error(e);process.exitCode=1;});
