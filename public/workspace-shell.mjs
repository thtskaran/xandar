// Shared navigation. Only a per-tab disclosure preference is stored; no application data changes.
const page=location.pathname.split('/').pop()||'index.html';
document.documentElement.classList.add('xander-workspace');
const primary=[['index.html','Overview','/#overview'],['results','Findings','/#results'],['system','System & evidence','/#system']];
const tools=[['capture.html','Browser observations','/capture.html'],['vault.html','Knowledge vault','/vault.html'],['answers.html','Ask the evidence','/answers.html'],['conditional.html','Conditional forecasts','/conditional.html'],['business.html','Juice Shop facts','/business.html']];
const sidebar=document.createElement('aside');sidebar.id='workspace-sidebar';sidebar.className='ws-sidebar';sidebar.setAttribute('aria-label','Juice Shop workspace');
sidebar.innerHTML=`<a class="ws-brand" href="/" aria-label="Xander home">xander<span>AI</span></a><div class="ws-workspace"><span class="ws-workspace-icon" aria-hidden="true">J</span><div><strong>Juice Shop</strong><small>LOCAL APPLICATION</small></div></div><button class="ws-close" aria-label="Close navigation">×</button><nav class="ws-nav" aria-label="Workspace navigation"></nav><div class="ws-bottom"><span class="ws-status-dot"></span> LOCAL WORKSPACE</div>`;
const nav=sidebar.querySelector('nav');
function navLink([id,label,href]){const link=document.createElement('a');link.href=href;link.textContent=label;link.dataset.page=id;return link;}
const destinations=document.createElement('div');destinations.className='ws-primary';for(const item of primary)destinations.append(navLink(item));nav.append(destinations);
const toolsGroup=document.createElement('details');toolsGroup.className='ws-group ws-tools';const summary=document.createElement('summary');summary.textContent='Workspace tools';toolsGroup.append(summary);for(const item of tools)toolsGroup.append(navLink(item));nav.append(toolsGroup);
// Resolve the disclosure before attaching the sidebar, avoiding a collapsed first paint.
const toolsStateKey='xander.workspace-tools.v1';
let storedTools=null;try{const value=JSON.parse(sessionStorage.getItem(toolsStateKey));if(value&&typeof value.open==='boolean'&&typeof value.page==='string')storedTools=value;}catch{}
const isToolPage=tools.some(([id])=>id===page);
toolsGroup.open=storedTools?.open===true||(isToolPage&&!(storedTools?.open===false&&storedTools.page===page));
summary.setAttribute('aria-expanded',String(toolsGroup.open));
function saveToolsState(){summary.setAttribute('aria-expanded',String(toolsGroup.open));try{sessionStorage.setItem(toolsStateKey,JSON.stringify({open:toolsGroup.open,page}));}catch{}}
// Native summary activation handles mouse, Enter and Space. Save synchronously,
// so immediate navigation cannot race the browser's queued toggle event.
summary.addEventListener('click',event=>{event.preventDefault();toolsGroup.open=!toolsGroup.open;saveToolsState();});
toolsGroup.addEventListener('toggle',saveToolsState);
const toggle=document.createElement('button');toggle.className='ws-toggle';toggle.type='button';toggle.setAttribute('aria-controls',sidebar.id);toggle.setAttribute('aria-expanded','false');toggle.setAttribute('aria-label','Open workspace navigation');toggle.innerHTML='<span aria-hidden="true">☰</span> <span>Juice Shop</span>';
const backdrop=document.createElement('div');backdrop.className='ws-backdrop';backdrop.hidden=true;backdrop.setAttribute('aria-hidden','true');
const skip=document.createElement('a');skip.className='ws-skip';skip.href='#workspace-main';skip.textContent='Skip to content';
document.body.prepend(skip,toggle,backdrop,sidebar);const main=document.querySelector('main');if(main){main.id ||= 'workspace-main';skip.href='#'+main.id;main.setAttribute('tabindex','-1');}
const mobile=matchMedia('(max-width: 900px)');let returnFocus=null;
function setOpen(open){if(open){returnFocus=document.activeElement;}document.body.classList.toggle('ws-nav-open',open);toggle.setAttribute('aria-expanded',String(open));backdrop.hidden=!open;sidebar.inert=mobile.matches&&!open;if(open)sidebar.querySelector('.ws-close').focus();else if(returnFocus&&mobile.matches){returnFocus.focus();returnFocus=null;}}
toggle.onclick=()=>setOpen(!document.body.classList.contains('ws-nav-open'));sidebar.querySelector('.ws-close').onclick=()=>setOpen(false);backdrop.onclick=()=>setOpen(false);
function markActive(){for(const a of nav.querySelectorAll('a')){const current=(page==='index.html'?((location.hash==='#results'||location.hash.startsWith('#run='))?a.dataset.page==='results':(location.hash==='#system'||location.hash==='#review')?a.dataset.page==='system':a.dataset.page==='index.html'):a.dataset.page===page);if(current)a.setAttribute('aria-current','page');else a.removeAttribute('aria-current');}toolsGroup.classList.toggle('ws-tools-current',Boolean(toolsGroup.querySelector('[aria-current]')));}markActive();window.addEventListener('hashchange',markActive);
nav.addEventListener('click',e=>{if(e.target.closest('a')){saveToolsState();if(mobile.matches)setOpen(false);}});
window.addEventListener('pageshow',()=>{markActive();summary.setAttribute('aria-expanded',String(toolsGroup.open));});
document.addEventListener('keydown',e=>{if(!mobile.matches||!document.body.classList.contains('ws-nav-open'))return;if(e.key==='Escape'){e.preventDefault();setOpen(false);}if(e.key==='Tab'){const nodes=[...sidebar.querySelectorAll('a,button,summary')].filter(n=>n.getClientRects().length);const first=nodes[0],last=nodes.at(-1);if(e.shiftKey&&document.activeElement===first){e.preventDefault();last.focus();}else if(!e.shiftKey&&document.activeElement===last){e.preventDefault();first.focus();}}});
mobile.addEventListener('change',()=>{setOpen(false);sidebar.inert=mobile.matches;});sidebar.inert=mobile.matches;
