// Staff-only parts of the dashboard, split out of app.js so riders do not download them. Loaded by staffReady() in app.js for administrators and moderators.
// ── Duplicate and inactive members ──
let tidyData=null, tidyErr='', tidyTab='dup', tidyDays=180, tidyReason='all', tidySel=new Set(), tidyBusy=false, tidyMsg='';

async function openTidy(){
  let m=document.getElementById('tidyModal');
  if(!m){ m=document.createElement('div'); m.id='tidyModal'; m.className='modal-bg'; m.onclick=e=>{ if(e.target===m) closeTidy(); }; document.body.appendChild(m); }
  m.style.display='flex'; tidyData=null; tidyErr=''; tidySel=new Set(); tidyMsg=''; renderTidy();
  try{ const r=await fetch('/api/members/tidy',{headers:tttHeaders()}), d=await r.json(); if(!r.ok) throw new Error(d.error||('HTTP '+r.status)); tidyData=d; }catch(e){ tidyErr=e.message; }
  renderTidy();
}

function closeTidy(){ const m=document.getElementById('tidyModal'); if(m) m.style.display='none'; }

document.addEventListener('keydown',e=>{ if(e.key==='Escape'){ const m=document.getElementById('tidyModal'); if(m&&m.style.display==='flex') closeTidy(); } });

const tidyAgo=d=>d===null||d===undefined?'unknown':d<2?'today':d<60?d+' days ago':d<700?Math.round(d/30)+' months ago':Math.round(d/365)+' years ago';

function tidyInactive(){
  const d=tidyData; if(!d) return [];
  return d.inactive.map(i=>({ ...i, why:[i.reasons.includes('not-in-club')?'Not in the Zwift club':'', i.reasons.includes('never-raced')?'Never raced':'', i.daysSinceRace!==null&&i.daysSinceRace>=tidyDays?'No race for '+tidyAgo(i.daysSinceRace).replace(' ago',''):''].filter(Boolean) })).filter(i=>i.why.length&&(tidyReason==='all'||(tidyReason==='club'&&i.reasons.includes('not-in-club'))||(tidyReason==='never'&&i.reasons.includes('never-raced'))||(tidyReason==='old'&&i.daysSinceRace!==null&&i.daysSinceRace>=tidyDays)));
}

function renderTidy(){
  const m=document.getElementById('tidyModal'); if(!m) return;
  const d=tidyData, btn='padding:5px 11px;font-size:12px;border-radius:6px;cursor:pointer;background:rgba(255,255,255,0.05);color:#e5e7eb;border:1px solid rgba(255,255,255,0.15)';
  const tab=(id,l,n)=>`<button onclick="tidyTab='${id}';tidyMsg='';renderTidy()" style="padding:6px 14px;font-size:13px;font-weight:700;border-radius:8px;cursor:pointer;border:1px solid ${tidyTab===id?'rgba(var(--accent-rgb),0.5)':'rgba(255,255,255,0.12)'};background:${tidyTab===id?'rgba(var(--accent-rgb),0.12)':'transparent'};color:${tidyTab===id?'var(--accent)':'#9ca3af'}">${l}${n!==undefined?` <span style="font-size:11px;opacity:.8">${n}</span>`:''}</button>`;
  const stCol=s=>s==='active'?'#10B981':s==='suspended'?'#F59E0B':s==='left'?'#F87171':'#8b95a5';
  let body='<div style="font-size:13px;color:#9ca3af">Looking through the members…</div>';
  if(tidyErr) body=`<div style="font-size:13px;color:#f87171">${esc(tidyErr)}</div>`;
  else if(d&&!d.hasMembers) body='<div style="font-size:13px;color:#FBBF24">The WordPress member records could not be read, so there is nothing to compare yet. '+esc(d.membersError||'')+'</div>';
  else if(d){
    const dup=d.duplicates, inact=tidyInactive();
    if(tidyTab==='dup'){
      const grp=g=>`<div style="padding:10px 12px;border:1px solid rgba(255,255,255,0.08);border-radius:10px;margin-bottom:8px"><div style="font-weight:800;font-size:14px;margin-bottom:6px">${esc(g.name)}</div>
        ${g.members.map(x=>`<div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;padding:4px 0;border-top:1px solid rgba(255,255,255,0.05);font-size:12px"><span style="min-width:74px;color:#9ca3af">${esc(x.zwid)}</span><span style="color:${stCol(x.status)};min-width:62px">${esc(x.status)}</span><span style="min-width:62px">${esc(x.tier||'—')}</span><span style="min-width:96px;color:${x.inClub?'#10B981':'#8b95a5'}">${x.inClub?'in Zwift club':'not in club'}</span><span style="flex:1;color:#9ca3af">raced ${esc(tidyAgo(x.daysSinceRace))}</span>
          ${x.zwid===g.keep?'<span style="font-size:11px;color:#10B981;font-weight:700">suggested to keep</span>':''}${x.hasRecord&&x.status!=='left'?`<button onclick="tidySet('${esc(x.zwid)}','left')" style="${btn}">Mark as left</button>`:''}<button onclick="openRider('${esc(x.zwid)}')" title="Open profile" style="${btn}">👤</button></div>`).join('')}
        ${g.members.filter(x=>x.zwid!==g.keep&&x.hasRecord&&x.status!=='left').length?`<div style="margin-top:6px"><button onclick="tidyKeep('${esc(g.keep)}','${esc(g.key)}')" style="${btn};background:rgba(16,185,129,0.1);color:#10B981;border-color:rgba(16,185,129,0.4)">Keep the suggested one, mark the others as left</button></div>`:''}</div>`;
      body=`<div style="font-size:12px;color:#9ca3af;margin-bottom:10px">The same name under more than one Zwift ID. People with a common name can be different riders, so check before marking anyone. Marking a member as left saves to WordPress and can be undone from the Members table.</div>
        ${dup.sameName.length?dup.sameName.map(grp).join(''):'<div style="font-size:13px;color:#10B981;margin-bottom:10px">✅ No one is listed under two Zwift IDs.</div>'}
        ${dup.sameId.length?`<div style="font-weight:800;font-size:13px;margin:16px 0 4px;color:#FBBF24">WordPress holds a Zwift ID twice (${dup.sameId.length})</div><div style="font-size:12px;color:#9ca3af;margin-bottom:6px">The app can only see one of the two records. Delete the extra one on cryogen.team.</div>${dup.sameId.map(x=>`<div style="font-size:12px;padding:4px 0;border-top:1px solid rgba(255,255,255,0.05)"><b>${esc(x.zwid)}</b> · ${x.records.map(r=>esc(r.name)+' ('+esc(r.status)+', '+esc(r.tier||'—')+')').join(' and ')}</div>`).join('')}`:''}
        ${dup.noId.length?`<div style="font-weight:800;font-size:13px;margin:16px 0 4px;color:#FBBF24">No usable Zwift ID in WordPress (${dup.noId.length})</div><div style="font-size:12px;color:#9ca3af;margin-bottom:6px">The app cannot manage these records because it finds a member by Zwift ID. Add the ID, or remove the record, on cryogen.team.</div><div style="max-height:160px;overflow:auto">${dup.noId.map(x=>`<div style="font-size:12px;padding:3px 0;border-top:1px solid rgba(255,255,255,0.05)">${esc(x.name||'(no name)')} · ${esc(x.status)} · ${esc(x.tier||'—')}${x.zwid?' · “'+esc(x.zwid)+'”':''}</div>`).join('')}</div>`:''}`;
    }else{
      const rb=(id,l)=>`<button onclick="tidyReason='${id}';renderTidy()" style="padding:3px 11px;font-size:12px;border-radius:99px;cursor:pointer;border:1px solid ${tidyReason===id?'rgba(var(--accent-rgb),0.5)':'rgba(255,255,255,0.12)'};background:${tidyReason===id?'rgba(var(--accent-rgb),0.12)':'transparent'};color:${tidyReason===id?'var(--accent)':'#9ca3af'}">${l}</button>`;
      const all=inact.map(i=>String(i.zwid)), allIn=all.length&&all.every(z=>tidySel.has(z));
      body=`<div style="font-size:12px;color:#9ca3af;margin-bottom:10px">Active members who may have drifted away. Associates are not flagged for being outside the Zwift club.</div>
        <div style="display:flex;gap:6px;flex-wrap:wrap;align-items:center;margin-bottom:10px"><span style="font-size:11px;font-weight:700;color:#8b95a5;text-transform:uppercase">Show</span>${rb('all','All')}${rb('club','Not in the Zwift club')}${rb('never','Never raced')}${rb('old','No race for…')}
          <select class="inp" style="width:auto" onchange="tidyDays=+this.value;renderTidy()">${[[60,'60 days'],[90,'90 days'],[180,'6 months'],[365,'a year']].map(([v,l])=>`<option value="${v}" ${tidyDays===v?'selected':''}>${l}</option>`).join('')}</select></div>
        ${inact.length?`<div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:8px"><label style="font-size:12px;cursor:pointer"><input type="checkbox" ${allIn?'checked':''} onchange="tidyAll(this.checked)"/> Select all ${inact.length}</label>${tidySel.size?`<b style="font-size:12px;color:var(--accent)">${tidySel.size} selected</b><button onclick="tidyBulk('suspended')" ${tidyBusy?'disabled':''} style="${btn};color:#F59E0B;border-color:rgba(245,158,11,0.4)">Suspend</button><button onclick="tidyBulk('left')" ${tidyBusy?'disabled':''} style="${btn};color:#f87171;border-color:rgba(239,68,68,0.4)">Mark as left</button><button onclick="tidyMessage()" style="${btn};color:#a5b4fc;border-color:rgba(88,101,242,0.45)">💬 Message them</button>`:''}</div>
          <div style="max-height:360px;overflow:auto">${inact.slice(0,300).map(i=>`<div style="display:flex;gap:8px;align-items:center;padding:6px 0;border-top:1px solid rgba(255,255,255,0.05);font-size:12px"><input type="checkbox" ${tidySel.has(String(i.zwid))?'checked':''} onchange="tidyPick('${esc(String(i.zwid))}',this.checked)"/><span style="flex:1;min-width:130px"><b>${rn(i.name,i.zwid,'',true)}</b> <span style="color:#8b95a5">${esc(i.zwid)}</span></span><span style="color:#FBBF24;flex:2;min-width:150px">${esc(i.why.join(' · '))}</span><span style="color:#9ca3af;min-width:90px">${i.inClub?'last raced '+esc(tidyAgo(i.daysSinceRace)):'not in club'}</span><button onclick="openRider('${esc(String(i.zwid))}')" title="Open profile" style="${btn}">👤</button></div>`).join('')}${inact.length>300?`<div style="font-size:11px;color:#8b95a5;padding:6px">Showing the first 300 of ${inact.length}: use the filters.</div>`:''}</div>`:'<div style="font-size:13px;color:#10B981">✅ Nobody matches.</div>'}`;
    }
    body+=tidyMsg?`<div style="font-size:12px;margin-top:10px;color:${tidyMsg.startsWith('✓')?'#10B981':'#f87171'}">${esc(tidyMsg)}</div>`:'';
  }
  const dup=d&&d.hasMembers?d.counts.sameName+d.counts.sameId+d.counts.noId:undefined;
  m.innerHTML=`<div class="modal" style="max-width:760px"><div class="modal-head"><span>🧹 Duplicates &amp; inactive members</span><button onclick="closeTidy()" aria-label="Close" style="background:none;border:none;color:#9ca3af;font-size:22px;padding:0 4px;cursor:pointer">×</button></div>
    <div class="modal-body"><div style="display:flex;gap:8px;margin-bottom:14px">${tab('dup','Duplicates',dup)}${tab('inact','Inactive',d&&d.hasMembers?tidyInactive().length:undefined)}</div>${body}</div></div>`;
}

function tidyPick(z,on){ if(on) tidySel.add(z); else tidySel.delete(z); renderTidy(); }

function tidyAll(on){ tidyInactive().forEach(i=>{ if(on) tidySel.add(String(i.zwid)); else tidySel.delete(String(i.zwid)); }); renderTidy(); }

async function tidyApply(zwids,changes){
  const r=await fetch('/api/members/bulk',{method:'POST',headers:tttHeaders(),body:JSON.stringify({ zwids, changes })}); const d=await r.json(); if(!r.ok) throw new Error(d.error||('HTTP '+r.status));
  const done=new Set(d.results.filter(x=>x.ok).map(x=>x.zwid));
  for(const rec of [...riders,...wpOnly]) if(done.has(String(rec.id))) applyMemberRecord(rec,changes);
  if(tidyData){ const gone=changes.status==='left'||changes.status==='suspended'; tidyData.inactive=tidyData.inactive.filter(i=>!(done.has(String(i.zwid))&&gone)); tidyData.duplicates.sameName.forEach(g=>g.members.forEach(x=>{ if(done.has(String(x.zwid))) x.status=changes.status; })); }
  renderMembers();
  return d;
}

async function tidySet(zwid,status){
  if(!confirm('Mark this member as '+(status==='left'?'having left the club':status)+'?')) return;
  try{ const d=await tidyApply([zwid],{ status }); tidyMsg=d.failed?('Not saved: '+(d.results.find(x=>!x.ok)||{}).error):'✓ Saved.'; }catch(e){ tidyMsg='Not saved: '+e.message; }
  renderTidy();
}

async function tidyKeep(keep,key){
  const g=tidyData.duplicates.sameName.find(x=>x.key===key); const ids=g.members.filter(x=>x.zwid!==keep&&x.hasRecord&&x.status!=='left').map(x=>x.zwid);
  if(!ids.length||!confirm('Keep '+g.name+' ('+keep+') and mark '+ids.length+' other record'+(ids.length===1?'':'s')+' as left?')) return;
  try{ const d=await tidyApply(ids,{ status:'left' }); tidyMsg=d.failed?('Saved '+d.saved+'. Not saved: '+d.results.filter(x=>!x.ok).map(x=>x.zwid+' '+x.error).join('; ')):'✓ Saved.'; }catch(e){ tidyMsg='Not saved: '+e.message; }
  renderTidy();
}

async function tidyBulk(status){
  const ids=[...tidySel]; if(!ids.length) return;
  if(ids.length>100){ tidyMsg='Choose at most 100 at a time.'; renderTidy(); return; }
  if(!confirm((status==='left'?'Mark ':'Suspend ')+ids.length+' member'+(ids.length===1?'':'s')+(status==='left'?' as having left the club?':'?')+'\n\nThis saves to WordPress. You can change it back in the Members table.')) return;
  tidyBusy=true; renderTidy();
  try{ const d=await tidyApply(ids,{ status }); ids.forEach(z=>{ if(d.results.find(x=>x.zwid===z&&x.ok)) tidySel.delete(z); }); tidyMsg=d.failed?('Saved '+d.saved+'. '+d.failed+' not saved: '+d.results.filter(x=>!x.ok).slice(0,4).map(x=>x.zwid+' '+x.error).join('; ')):'✓ Saved '+d.saved+'.'; }catch(e){ tidyMsg='Not saved: '+e.message; }
  tidyBusy=false; renderTidy();
}

function tidyMessage(){ mSel=new Set(tidySel); closeTidy(); commsFromMembers(); }

// ── Google Sheet sync (Admin): pull the sheet into the app (the sheet wins), push the app's teams to a mirror tab ──
let syncData=null, syncErr='', syncBusy='', syncMsg='';

async function syncCall(method,path,body){
  const r=await fetch(path,{method,headers:tttHeaders(),body:method==='GET'?undefined:JSON.stringify(body||{})});
  const d=await r.json().catch(()=>({})); if(!r.ok) throw new Error(d.error||('HTTP '+r.status)); return d;
}

// Personal staff accounts (administrators only): each person signs in as themselves and their name appears in the change log.
let staffList=null, staffMsg='';

async function loadStaff(){
  const el=document.getElementById('staff-card'); if(!el) return;
  if(role!=='admin'){ el.innerHTML=''; return; }
  try{ const r=await fetch('/api/staff',{headers:tttHeaders()}); const d=await r.json(); staffList=r.ok?d.users:[]; }catch(e){ staffList=[]; }
  renderStaff();
}

function renderStaff(){
  const el=document.getElementById('staff-card'); if(!el||role!=='admin'||!staffList) return;
  const btn='padding:4px 10px;font-size:11px;background:rgba(255,255,255,0.05);color:#e5e7eb;border:1px solid rgba(255,255,255,0.15);border-radius:6px;cursor:pointer';
  el.innerHTML=`<div style="background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.1);border-radius:10px;padding:14px;margin-top:12px"><div style="font-size:11px;font-weight:700;color:var(--accent);margin-bottom:6px">🔑 Staff accounts</div>
    <div style="font-size:12px;color:#9ca3af;margin-bottom:8px">Each person signs in with their own username and password, and their name appears in the change log. The shared passwords keep working until you retire them.</div>
    ${staffList.map(u=>`<div style="display:flex;gap:8px;align-items:center;font-size:12px;padding:4px 0;border-top:1px solid rgba(255,255,255,0.05)"><b style="flex:1">${esc(u.name)} <span style="color:#8b95a5;font-weight:400">${esc(u.username)} · ${u.role==='admin'?'administrator':'moderator'}</span></b><button onclick="staffEdit('${esc(u.username)}')" style="${btn}">Edit</button><button onclick="staffRemove('${esc(u.username)}')" style="${btn}">Remove</button></div>`).join('')||'<div style="font-size:12px;color:#8b95a5">No personal accounts yet.</div>'}
    <button onclick="staffEdit('')" style="${btn};margin-top:8px">+ Add a person</button> <button onclick="pushKeys()" title="Makes the keys that switch on notifications for riders' devices" style="${btn};margin-top:8px">🔔 Make push keys</button>${staffMsg?`<div style="font-size:12px;margin-top:6px;color:${staffMsg.startsWith('✓')?'#10B981':'#f87171'}">${esc(staffMsg)}</div>`:''}</div>`;
}

async function staffEdit(username){
  const cur=(staffList||[]).find(u=>u.username===username)||{};
  const uname=username||prompt('Username (letters, numbers, dots or dashes):'); if(!uname) return;
  const name=prompt('Name shown in the change log:',cur.name||''); if(!name) return;
  const roleIn=(prompt('Role: type admin or mod',cur.role||'mod')||'').trim(); if(!roleIn) return;
  const pw=prompt(username?'New password (leave empty to keep the current one):':'Password (at least 10 characters):','');
  if(pw===null) return;
  try{ const r=await fetch('/api/staff',{method:'POST',headers:tttHeaders(),body:JSON.stringify({ username:uname, name, role:roleIn, password:pw })}); const d=await r.json(); if(!r.ok) throw new Error(d.error||'Could not save.'); staffMsg='✓ Saved.'; }catch(e){ staffMsg=e.message; }
  loadStaff();
}

async function pushKeys(){
  if(!confirm('This makes a new key pair for notifications. Add the two values in Vercel (Settings, Environment Variables) as VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY, then redeploy. Keep the private one secret. Changing keys later switches every device off. Continue?')) return;
  try{ const r=await fetch('/api/push/generate-keys',{method:'POST',headers:tttHeaders(),body:'{}'}); const d=await r.json(); if(!r.ok) throw new Error(d.error||'Could not make keys.');
    prompt('Copy these two lines into Vercel as environment variables (the private key is a secret):','VAPID_PUBLIC_KEY='+d.publicKey+'\nVAPID_PRIVATE_KEY='+d.privateKey); }catch(e){ alert(e.message); }
}

async function staffRemove(username){
  if(!confirm('Remove '+username+'? They can no longer sign in (a session already open lasts until it expires).')) return;
  try{ const r=await fetch('/api/staff/remove',{method:'POST',headers:tttHeaders(),body:JSON.stringify({ username })}); const d=await r.json(); if(!r.ok) throw new Error(d.error||'Could not remove.'); staffMsg='✓ Removed.'; }catch(e){ staffMsg=e.message; }
  loadStaff();
}

async function loadSync(){
  if(role!=='admin'&&role!=='mod') return;
  try{ syncData=await syncCall('GET','/api/sync'); syncErr=''; }catch(e){ syncErr=e.message; }
  renderSync();
}

// Staff opening TTT or ZRL: what is switched on runs, at most every ten minutes, and the page reloads if the sheet changed anything.
async function syncAuto(series){
  if(role!=='admin'&&role!=='mod') return;
  try{
    const d=await syncCall('POST','/api/sync/auto',{ series });
    if(d.ran&&d.ran.includes('pull')){ if(series==='ttt') loadTtt(); else loadZrl(); }
  }catch(e){ /* the Admin card shows problems */ }
}

function renderSync(){
  const el=document.getElementById('sync-card'); if(!el) return;
  const d=syncData, btn='padding:6px 12px;font-size:12px;font-weight:700;border-radius:8px;cursor:pointer;background:rgba(var(--accent-rgb),0.1);color:var(--accent);border:1px solid rgba(var(--accent-rgb),0.3)';
  const when=iso=>new Date(iso).toLocaleString('en-GB',{timeZone:tzZone(),day:'numeric',month:'short',hour:'2-digit',minute:'2-digit'});
  let body;
  if(syncErr) body=`<div style="font-size:12px;color:#f87171">${esc(syncErr)}</div>`;
  else if(!d) body='<div style="font-size:12px;color:#9ca3af">Loading…</div>';
  else{
    const g=d.google, admin=d.canChange;
    const google=g.configured?`<div style="font-size:12px;color:#10B981;margin-bottom:8px">✅ Google service account: <b>${esc(g.email)}</b>. Share each sheet with this address as an <b>Editor</b>.</div>`
      :`<div style="font-size:12px;color:#FBBF24;margin-bottom:8px">Publishing to the sheets needs a Google service account${g.error?' ('+esc(g.error)+')':''}. In Google Cloud create one, enable the Google Sheets API, make a JSON key, and add it in Vercel as GOOGLE_SERVICE_ACCOUNT_JSON. Reading the sheets into the app works without it.</div>`;
    const row=(id,s)=>{
      const st=s.state||{}, pu=st.push, pl=st.pull;
      const line=(label,x,ok)=>x?`<div style="font-size:11px;color:${x.ok?'#9ca3af':'#f87171'}">${label}: ${x.ok?esc(ok(x)):'failed, '+esc(x.error)} · ${esc(when(x.at))}</div>`:`<div style="font-size:11px;color:#8b95a5">${label}: not run yet</div>`;
      const tog=(key,label)=>`<label style="font-size:12px;display:inline-flex;gap:6px;align-items:center;margin-right:12px;${admin?'cursor:pointer':'opacity:.6'}"><input type="checkbox" ${s.settings[key]?'checked':''} ${admin?'':'disabled'} onchange="syncToggle('${id}','${key}',this.checked)"/> ${label}</label>`;
      return `<div style="padding:10px 0;border-top:1px solid rgba(255,255,255,0.06)"><div style="font-weight:800;font-size:13px;margin-bottom:2px">${esc(s.label)} <span style="font-weight:400;font-size:11px;color:#8b95a5">· ${s.canPull?esc(s.pullTab)+' tab in':'sheet'} <a href="https://docs.google.com/spreadsheets/d/${esc(s.sheetId)}/edit" target="_blank" rel="noopener" style="color:#8b95a5">${esc(s.sheetId.slice(0,8))}…</a> · writes “${esc(s.mirrorTab)}”</span></div>
        ${s.canPull?line('Sheet → app',pl,x=>Object.entries(x.summary||{}).filter(([,v])=>typeof v==='number').map(([k,v])=>v+' '+k).join(', ')||'done'):''}${line('App → sheet',pu,x=>x.rows+' rows written')}
        <div style="margin:6px 0">${s.canPull?tog('pull','Keep the app in step with the sheet (sheet wins)'):''}${tog('push','Keep the mirror tab up to date')}${s.settings.push&&!d.google.configured?'<span style="font-size:11px;color:#FBBF24">waiting for the Google key: nothing is written yet</span>':''}${s.canPull?'':'<span style="font-size:11px;color:#8b95a5">published to the sheet only</span>'}</div>
        <div style="display:flex;gap:6px;flex-wrap:wrap">${s.canPull?`<button ${syncBusy?'disabled':''} onclick="syncRun('${id}','pull')" style="${btn}">${syncBusy===id+'pull'?'Reading…':'Pull from the sheet now'}</button>`:''}<button ${syncBusy?'disabled':''} onclick="syncRun('${id}','push')" style="${btn}">${syncBusy===id+'push'?'Writing…':'Publish to the sheet now'}</button>${admin?`<button onclick="syncSheet('${id}',${s.customSheet})" style="${btn};background:none;color:#9ca3af;border-color:rgba(255,255,255,0.15)">Change sheet</button>`:''}</div></div>`;
    };
    body=google+Object.entries(d.series).map(([id,s])=>row(id,s)).join('')+`<div style="font-size:11px;color:#8b95a5;margin-top:8px">The sheet wins: with “keep in step” on, a change made only in the app is replaced at the next sync. The app never writes to your own tabs, only its mirror tab, which is replaced each time. Runs happen every 15 minutes, and when staff open the TTT or ZRL page.</div>`;
  }
  el.innerHTML=`<div style="background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.1);border-radius:10px;padding:14px"><div style="font-size:11px;font-weight:700;color:var(--accent);margin-bottom:6px">🔄 Google Sheet sync</div>${body}${syncMsg?`<div style="font-size:12px;margin-top:8px;color:${syncMsg.startsWith('✓')?'#10B981':'#f87171'}">${esc(syncMsg)}</div>`:''}</div>`;
}

async function syncToggle(series,key,on){
  syncMsg='';
  try{ syncData=await syncCall('POST','/api/sync/settings',{ series, [key]:on }); }catch(e){ syncMsg=e.message; try{ syncData=await syncCall('GET','/api/sync'); }catch(x){} }
  renderSync();
}

async function syncSheet(series,custom){
  const v=prompt('Paste the Google Sheet link (or its ID) to use for '+series.toUpperCase()+'. Leave empty to go back to the club sheet.','');
  if(v===null) return; syncMsg='';
  try{ syncData=await syncCall('POST','/api/sync/settings',{ series, sheetId:v.trim() }); syncMsg='✓ Sheet changed.'; }catch(e){ syncMsg=e.message; }
  renderSync();
}

async function syncRun(series,direction){
  if(direction==='pull'&&!confirm('Read the sheet into the app now? The sheet wins: riders are placed as the sheet has them, and a rider the sheet no longer lists is taken off that team.')) return;
  syncBusy=series+direction; syncMsg=''; renderSync();
  try{
    const d=await syncCall('POST','/api/sync/run',{ series, direction }); syncData=d;
    const r=d.result||{}, bad=Object.entries(r).filter(([,v])=>v&&v.error);
    syncMsg=bad.length?bad.map(([k,v])=>(k==='pull'?'Sheet → app: ':'App → sheet: ')+v.error).join(' · '):'✓ Done.';
    if(!bad.length&&direction==='pull'){ if(series==='ttt') loadTtt(); else loadZrl(); }
  }catch(e){ syncMsg=e.message; }
  syncBusy=''; renderSync();
}

// ── Backups (admin) ────────────────────────────────────────
async function backupCall(path,body){
  const res=await fetch(path,body===undefined?{headers:tttHeaders()}:{method:'POST',headers:tttHeaders(),body:JSON.stringify(body)});
  const d=await res.json(); if(!res.ok) throw new Error(d.error||('HTTP '+res.status)); return d;
}

async function loadBackups(){
  const el=document.getElementById('backup-panel'); if(!el||role!=='admin') { if(el&&role!=='admin') document.getElementById('backup-box').style.display='none'; return; }
  try{
    const d=await backupCall('/api/admin/backups'), when=iso=>new Date(iso).toLocaleString('en-GB',{day:'numeric',month:'short',hour:'2-digit',minute:'2-digit'});
    const btn='padding:2px 8px;font-size:11px;background:rgba(255,255,255,0.05);color:#e5e7eb;border:1px solid rgba(255,255,255,0.15);border-radius:5px;cursor:pointer';
    el.innerHTML=d.backups.length?d.backups.map(b=>`<div style="display:flex;gap:6px;align-items:center;padding:4px 0;border-top:1px solid rgba(255,255,255,0.05)"><div style="flex:1">${esc(when(b.at))} <span style="color:#8b95a5">· ${esc(b.kind)} · ${b.kb} KB</span></div>
      <button data-id="${esc(b.id)}" onclick="backupDownload(this.dataset.id)" style="${btn}">Download</button><button data-id="${esc(b.id)}" onclick="backupRestore(this.dataset.id)" style="${btn};color:#f87171;border-color:rgba(239,68,68,0.3)">Restore</button></div>`).join(''):'No copies yet. One is taken each day by the scheduled run.';
  }catch(e){ el.innerHTML=`<span style="color:#f87171">${esc(e.message)}</span>`; }
}

async function backupVerify(){ try{ const r=await backupCall('/api/admin/backup-verify',{}); alert(r.ok?'Restore test passed: the newest copy unpacks and holds '+r.backupItems+' items ('+r.liveItems+' live). Nothing was changed.':'Restore test FAILED:\n'+r.problems.join('\n')); }catch(e){ alert(e.message); } loadBackups(); }

async function backupNow(){ try{ await backupCall('/api/admin/backup-now',{}); }catch(e){ alert(e.message); } loadBackups(); }

async function backupDownload(id){
  try{
    const d=await backupCall('/api/admin/backup-download'+(id?'?id='+encodeURIComponent(id):''));
    const a=document.createElement('a'); a.href=URL.createObjectURL(new Blob([JSON.stringify(d)],{type:'application/json'}));
    a.download='cryogen-backup-'+String(d.at||'').slice(0,16).replace(/[:T]/g,'-')+'.json'; document.body.appendChild(a); a.click(); a.remove();
  }catch(e){ alert(e.message); }
}

async function backupRestore(id){
  const t=prompt('This REPLACES the current ZRL and TTT data with this copy. A safety copy of what is there now is kept first.\n\nType RESTORE to continue:');
  if(t===null) return;
  try{ await backupCall('/api/admin/restore',{ id, confirm:t.trim() }); alert('Restored. Reload the page to see it.'); }catch(e){ alert(e.message); }
  loadBackups();
}

// ── Fair play (staff) ──────────────────────────────────────
let fairData=null;

async function loadFair(){
  const el=document.getElementById('fair-content'); if(!el) return;
  if(!fairData) el.innerHTML='<div style="color:#8b95a5;padding:20px">Loading…</div>';
  try{ const r=await fetch('/api/fairplay',{headers:tttHeaders()}); const d=await r.json(); if(!r.ok) throw new Error(d.error||('HTTP '+r.status)); fairData=d; renderFair(); }
  catch(e){ el.innerHTML=`<div class="card" style="padding:20px;color:#f87171">${esc(e.message)}</div>`; }
}

function renderFair(){
  const el=document.getElementById('fair-content'), d=fairData; if(!el||!d) return;
  const sev={1:['Low','#FBBF24'],2:['Medium','#FB923C'],3:['High','#f87171']};
  const st={open:'To review',ok:'Looked at: fine',confirmed:'Confirmed',dismissed:'Dismissed'};
  const btn='padding:4px 10px;font-size:11px;border-radius:6px;border:1px solid rgba(255,255,255,0.18);background:rgba(255,255,255,0.05);color:#e5e7eb;cursor:pointer';
  const rows=d.flags.map(f=>`<tr style="opacity:${f.status==='open'?1:.6}">
    <td>${rn(f.name,f.zwid,'')}</td><td>${esc(f.typeLabel)}</td>
    <td><span class="badge" style="background:${sev[f.severity][1]}22;color:${sev[f.severity][1]};border:1px solid ${sev[f.severity][1]}55">${sev[f.severity][0]}</span></td>
    <td style="white-space:nowrap">${esc(f.at)}</td><td style="font-size:12px;color:#d1d5db">${esc(f.metric)}${f.note?`<div style="color:#8b95a5;margin-top:2px">Note: ${esc(f.note)}</div>`:''}</td>
    <td style="white-space:nowrap"><span style="font-size:11px;color:#8b95a5">${esc(st[f.status])}${f.reviewedBy?' · '+esc(f.reviewedBy):''}</span><div style="display:flex;gap:4px;flex-wrap:wrap;margin-top:4px">
      <a href="${esc(f.profile)}" target="_blank" rel="noopener" style="${btn};text-decoration:none">Review ↗</a>
      <button type="button" style="${btn}" data-z="${esc(f.zwid)}" data-t="${esc(f.typeLabel+' · '+f.at)}" data-n="${esc('From Fair play ('+f.at+'): '+f.typeLabel+'. '+f.metric)}" data-f="${esc(f.id)}" onclick="invFromFlag(this.dataset.z,this.dataset.t,this.dataset.n,this.dataset.f)">🕵️ Investigate</button>
      ${f.status==='open'?`<button type="button" style="${btn}" onclick="fairReview('${esc(f.id)}','ok')">Fine</button><button type="button" style="${btn}" onclick="fairReview('${esc(f.id)}','confirmed')">Confirm</button><button type="button" style="${btn}" onclick="fairReview('${esc(f.id)}','dismissed')">Dismiss</button>`:`<button type="button" style="${btn}" onclick="fairReview('${esc(f.id)}','open')">Reopen</button>`}</div></td></tr>`).join('');
  el.innerHTML=`<div style="display:flex;justify-content:space-between;align-items:flex-start;gap:12px;flex-wrap:wrap;margin-bottom:12px"><div><h2 style="font-size:20px;font-weight:900;margin-bottom:4px">🔎 Fair play</h2><p style="font-size:13px;color:#8b95a5">${d.open} to review · last checked ${esc(d.lastRun||'never')}</p></div>
      ${role==='admin'?`<button type="button" style="${btn}" onclick="fairRun(this)">Check now</button>`:''}</div>
    <div class="card" style="padding:12px 16px;margin-bottom:14px;font-size:13px;color:#d1d5db">These are <b>prompts for a person to look</b>, not findings. A heavy block of training, a real weight change or a new trainer can look the same as something worse. Nothing is sent to the rider and members cannot see this page. Look at the rider's profile, talk to them if needed, then mark the item.<div style="margin-top:6px;color:#8b95a5;font-size:12px">Checked daily from the club roster: registered weight (a drop of more than 2 kg in 7 days), 5 and 20 minute W/kg (more than 5% above their best of the last 90 days) and vELO (a rise of 150 or more in 14 days). Not checked, because the club does not receive the data: ${d.cannotSee.map(esc).join('; ')}. A reading needs about three weeks of daily history before the W/kg check can speak.</div></div>
    ${d.flags.length?`<div class="card" style="overflow-x:auto"><table><thead><tr><th>Rider</th><th>What</th><th>Severity</th><th>Date</th><th>The numbers</th><th>Review</th></tr></thead><tbody>${rows}</tbody></table></div>`
      :(window.uiEmpty?uiEmpty('✅','Nothing to look at','No rider has stood out in the daily check. It keeps watching.','',''):'Nothing to look at.')}`;
}

async function fairReview(id,status){
  let note=null;
  if(status!=='open'){ note=prompt('A short note for the record (optional):',''); if(note===null) return; }
  try{ const r=await fetch('/api/fairplay/review',{method:'POST',headers:{...tttHeaders(),'Content-Type':'application/json'},body:JSON.stringify({id,status,note})}); const d=await r.json(); if(!r.ok) throw new Error(d.error||('HTTP '+r.status)); }
  catch(e){ alert(e.message); }
  loadFair();
}

async function fairRun(btn){
  btn.disabled=true; btn.textContent='Checking…';
  try{ const r=await fetch('/api/fairplay/run',{method:'POST',headers:{...tttHeaders(),'Content-Type':'application/json'},body:'{}'}); const d=await r.json(); if(!r.ok) throw new Error(d.error||('HTTP '+r.status)); }catch(e){ alert(e.message); }
  loadFair();
}

// ── System health (admin) ──────────────────────────────────
let healthTimer=null;

function openAdmin(){
  document.getElementById('adminModal').style.display='flex';
  loadHealth(); loadGoLive(); if(window.supLoad) supLoad(); loadBackups(); loadSync(); loadStaff();
  if(healthTimer) clearInterval(healthTimer);
  healthTimer=setInterval(()=>{   // keep the checks fresh while the panel is open
    const m=document.getElementById('adminModal');
    if(!m||m.style.display==='none'){ clearInterval(healthTimer); healthTimer=null; return; }
    if(document.visibilityState==='visible') loadHealth(true);
  },30000);
}

function closeAdmin(){
  document.getElementById('adminModal').style.display='none';
  if(healthTimer){ clearInterval(healthTimer); healthTimer=null; }
}

async function historyDownload(btn){
  btn.disabled=true;
  try{
    const res=await fetch('/api/history/export',{headers:tttHeaders()}); const d=await res.json(); if(!res.ok) throw new Error(d.error||('HTTP '+res.status));
    const bin=atob(d.base64), bytes=new Uint8Array(bin.length); for(let i=0;i<bin.length;i++) bytes[i]=bin.charCodeAt(i);
    const a=document.createElement('a'); a.href=URL.createObjectURL(new Blob([bytes],{type:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'})); a.download=d.filename; document.body.appendChild(a); a.click(); a.remove(); setTimeout(()=>URL.revokeObjectURL(a.href),2000);
  }catch(e){ alert(e.message); }
  btn.disabled=false;
}

async function selfCheck(btn){
  const out=document.getElementById('selfcheck-out'); btn.disabled=true; out.textContent='Checking… (about 10 seconds)';
  try{
    const res=await fetch('/api/selfcheck',{method:'POST',headers:{...tttHeaders(),'Content-Type':'application/json'},body:'{}'});
    const d=await res.json(); if(!res.ok) throw new Error(d.error||('HTTP '+res.status));
    const ico={ok:'✅',fail:'❌',skip:'➖'};
    out.innerHTML=`<div style="font-weight:700;color:${d.ok?'#10B981':'#f87171'};margin-bottom:4px">${d.ok?'Everything that is switched on works.':d.failing+' thing'+(d.failing===1?'':'s')+' not working'}</div>`
      +d.steps.map(x=>`<div style="padding:3px 0">${ico[x.status]||'•'} <b>${esc(x.label)}</b> <span style="color:#8b95a5">${esc(x.detail)}</span></div>`).join('');
  }catch(e){ out.innerHTML=`<span style="color:#f87171">${esc(e.message)}</span>`; }
  btn.disabled=false;
}

async function stagingSeed(){
  try{
    const res=await fetch('/api/staging/seed',{method:'POST',headers:{...tttHeaders(),'Content-Type':'application/json'},body:'{}'});
    const d=await res.json(); if(!res.ok) throw new Error(d.error||('HTTP '+res.status));
    alert(d.message);
  }catch(e){ alert(e.message); }
}

// A coloured bar on a staging copy so nobody mistakes it for the real thing.
(async function stagingBanner(){
  try{
    const d=await (await fetch('/api/auth/status')).json();
    if(!d.staging) return;
    const b=document.createElement('div');
    b.textContent='🧪 STAGING — practice copy with made-up data. Nothing here is real.';
    b.style.cssText='position:sticky;top:0;z-index:9999;background:#FBBF24;color:#111;font:700 12px sans-serif;text-align:center;padding:5px';
    document.body.prepend(b);
  }catch(e){ /* no banner is not a problem */ }
})();

// What is switched on and what still needs doing before race week.
async function loadGoLive(){
  const el=document.getElementById('golive-card'); if(!el) return;
  try{
    const res=await fetch('/api/golive',{headers:tttHeaders()});
    const d=await res.json();
    if(!res.ok) throw new Error(d.error||('HTTP '+res.status));
    const icon={ok:'✅',todo:'⬜',off:'💤'};
    const row=i=>`<div style="display:flex;gap:8px;padding:6px 0;border-top:1px solid rgba(255,255,255,0.05)"><div style="flex:none">${icon[i.state]||'•'}</div><div><div style="font-weight:700;color:#e5e7eb">${esc(i.title)}</div><div style="color:#9ca3af">${esc(i.detail||'')}</div>${i.state!=='ok'&&i.how?`<div style="color:#FBBF24;margin-top:2px">${esc(i.how)}</div>`:''}</div></div>`;
    const todo=d.items.filter(i=>i.state!=='ok'), done=d.items.filter(i=>i.state==='ok');
    el.innerHTML=(d.staging?`<div style="margin-bottom:8px"><button onclick="stagingSeed()" style="padding:6px 10px;background:rgba(251,191,36,0.12);color:#FBBF24;border:1px solid rgba(251,191,36,0.3);border-radius:6px;font-size:11px;font-weight:700">🧪 Fill with test data</button></div>`:'')+`<div style="margin-bottom:6px;color:#9ca3af">${d.ready?'<b style="color:#10B981">Ready for race week</b>':`<b style="color:#FBBF24">${d.todo} to do</b>`} · ${done.length} of ${d.items.length} done</div>`
      +todo.map(row).join('')
      +(done.length?`<details style="margin-top:6px;border-top:1px solid rgba(255,255,255,0.05)"><summary style="cursor:pointer;padding:6px 0;color:#9ca3af">${done.length} done</summary>${done.map(row).join('')}</details>`:'');
  }catch(e){ el.innerHTML=`<span style="color:#f87171">Could not load: ${esc(e.message)}</span>`; }
}

// Problems first and open; the checks that are fine are folded away so the panel stays short.
async function loadHealth(quiet){
  const el=document.getElementById('health-panel'); if(!el) return;
  if(!quiet||!el.dataset.loaded) el.innerHTML='Checking…';
  try{
    const res=await fetch('/api/health',{headers:tttHeaders()});
    const d=await res.json();
    if(!res.ok) throw new Error(d.error||('HTTP '+res.status));
    const icon={ok:'✅',warn:'⚠️',fail:'❌',info:'ℹ️'};
    healthDotSet(d.checks);
    const count=k=>d.checks.filter(c=>c.status===k).length;
    const row=c=>`<div style="display:flex;gap:8px;padding:6px 0;border-top:1px solid rgba(255,255,255,0.05)"><div style="flex:none">${icon[c.status]||'•'}</div><div><div style="font-weight:700;color:#e5e7eb">${esc(c.label)}</div><div style="color:${c.status==='fail'?'#f87171':c.status==='warn'?'#FBBF24':'#9ca3af'}">${esc(c.detail)}</div></div></div>`;
    const bad=d.checks.filter(c=>c.status==='fail'||c.status==='warn').sort((a,b)=>(a.status==='fail'?0:1)-(b.status==='fail'?0:1)), fine=d.checks.filter(c=>c.status!=='fail'&&c.status!=='warn');
    const wasOpen=!!(el.querySelector('details')&&el.querySelector('details').open);
    el.dataset.loaded='1';
    el.innerHTML=`<div style="margin-bottom:8px;color:#9ca3af">${count('fail')?`<b style="color:#f87171">${count('fail')} failing</b> · `:''}${count('warn')?`<b style="color:#FBBF24">${count('warn')} to look at</b> · `:''}${count('ok')} OK · checked ${esc(new Date(d.checked).toLocaleTimeString('en-GB',{hour:'2-digit',minute:'2-digit',second:'2-digit'}))}</div>`
      +bad.map(row).join('')
      +(fine.length?`<details ${wasOpen||!bad.length?'open':''} style="margin-top:6px;border-top:1px solid rgba(255,255,255,0.05)"><summary style="cursor:pointer;padding:6px 0;color:#9ca3af">${fine.length} check${fine.length===1?'':'s'} fine</summary>${fine.map(row).join('')}</details>`:'');
  }catch(e){ el.innerHTML=`<span style="color:#f87171">Could not run the checks: ${esc(e.message)}</span>`; }
}
