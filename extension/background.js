const API = "http://127.0.0.1:8787";
const sleep = ms => new Promise(r => setTimeout(r, ms));

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({ id:"translate-direct", title:"GPT 直譯成繁中", contexts:["selection"] });
    chrome.contextMenus.create({ id:"translate-novel", title:"GPT 小說模式翻成繁中", contexts:["selection"] });
    chrome.contextMenus.create({ id:"translate-selected-full", title:"📚 GPT 翻譯選取的完整小說", contexts:["selection"] });
    chrome.contextMenus.create({ id:"translate-page", title:"🧪 GPT 翻譯本頁小說（實驗）", contexts:["page"] });
  });
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick:true }).catch(console.error);
});

function pageInfo(tab){ return {url:tab?.url||"", title:tab?.title||"", chapterTitle:tab?.title||""}; }
async function richPageInfo(tab){
  const base=pageInfo(tab); if(!tab?.id) return base;
  try {
    const [r]=await chrome.scripting.executeScript({target:{tabId:tab.id},func:()=>{
      const url=location.href; let title=document.title; let chapterTitle=document.title;
      if(location.hostname.endsWith('archiveofourown.org')){
        const workTitle=document.querySelector('h2.title.heading')?.textContent?.trim();
        const chapter=document.querySelector('#chapters .chapter h3.title')?.textContent?.replace(/^Chapter\s+\d+[:.]?\s*/i,'').trim() || document.querySelector('h3.title')?.textContent?.trim();
        if(workTitle) title=workTitle; if(chapter) chapterTitle=chapter;
      }
      return {url,title,chapterTitle};
    }}); return {...base,...(r?.result||{})};
  } catch { return base; }
}
async function setState(x){ await chrome.storage.local.set(x); }
function openPanel(tab){ if(Number.isInteger(tab?.windowId)) chrome.sidePanel.open({windowId:tab.windowId}).catch(console.error); }

async function translateSelection(text, mode, page={}){
  if(!text?.trim()) return;
  await setState({state:"loading",source:text,mode,translation:"",error:"",saved:null,progress:null,usage:null,fullPage:false});
  try{
    const r=await fetch(`${API}/translate`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({text,mode,url:page.url||"",title:page.title||"",chapterTitle:page.chapterTitle||""})});
    const data=await r.json(); if(!r.ok) throw new Error(data.error||`HTTP ${r.status}`);
    await setState({state:"done",translation:data.translation||"",usage:data.usage||null,saved:data.saved||null,error:"",progress:null});
  }catch(e){ await setState({state:"error",error:String(e?.message||e),progress:null}); }
}

async function runFullTextJob(text, page={}, origin="selection"){
  text=String(text||"").trim();
  if(!text) return;
  await setState({state:"preparing",source:text,translation:"",mode:"novel",error:"",saved:null,usage:null,progress:{current:0,total:0,message:`已取得 ${text.length.toLocaleString()} 字，準備自動分段…`},fullPage:true,origin});
  try{
    const r=await fetch(`${API}/translate-page`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({text,url:page.url||"",title:page.title||"",chapterTitle:page.chapterTitle||"",mode:"novel"})});
    const data=await r.json(); if(!r.ok) throw new Error(data.error||`HTTP ${r.status}`);
    const jobId=data.jobId;
    for(;;){
      await sleep(900);
      const jr=await fetch(`${API}/jobs/${encodeURIComponent(jobId)}`); const j=await jr.json();
      if(!jr.ok) throw new Error(j.error||`HTTP ${jr.status}`);
      await setState({state:j.status==='done'?'done':j.status==='error'?'error':'loading',progress:{current:j.current||0,total:j.total||0,message:j.message||"翻譯中…"},translation:j.translation||"",saved:j.saved||null,usage:j.usage||null,error:j.error||""});
      if(j.status==='done'||j.status==='error') break;
    }
  }catch(e){ await setState({state:"error",error:String(e?.message||e),progress:null}); }
}

function extractReadableText(){
  const clean = s => (s||"").replace(/\u00a0/g," ").replace(/[ \t]+\n/g,"\n").replace(/\n{3,}/g,"\n\n").trim();
  const candidates=[];
  const selectors=['article','main','[role="main"]','[data-testid*="novel"]','[class*="novel"]','[class*="Novel"]','[class*="story"]','[class*="Story"]','[class*="content"]','[class*="Content"]'];
  for(const sel of selectors){ document.querySelectorAll(sel).forEach(el=>{ const text=clean(el.innerText); if(text.length>500) candidates.push({text,score:text.length}); }); }
  document.querySelectorAll('section, div').forEach(el=>{
    if(el.children.length>80) return; const style=getComputedStyle(el); if(style.display==='none'||style.visibility==='hidden') return;
    const text=clean(el.innerText); if(text.length<1200) return; const score=text.length-(el.querySelectorAll('a').length*80)-(el.querySelectorAll('button').length*120); candidates.push({text,score});
  });
  candidates.sort((a,b)=>b.score-a.score);
  let title=document.title,chapterTitle=document.title;if(location.hostname.endsWith('archiveofourown.org')){title=document.querySelector('h2.title.heading')?.textContent?.trim()||title;chapterTitle=document.querySelector('#chapters .chapter h3.title')?.textContent?.replace(/^Chapter\s+\d+[:.]?\s*/i,'').trim()||chapterTitle;}return {text:candidates[0]?.text||clean(document.body.innerText),title,chapterTitle,url:location.href};
}

async function startPageTranslation(tab){
  if(!tab?.id) return; openPanel(tab);
  await setState({state:"extracting",source:"",translation:"",mode:"novel",error:"",saved:null,usage:null,progress:{current:0,total:0,message:"正在實驗性擷取本頁正文…"},fullPage:true,origin:"page"});
  try{
    const results=await chrome.scripting.executeScript({target:{tabId:tab.id},func:extractReadableText}); const page=results?.[0]?.result;
    if(!page?.text || page.text.length<50) throw new Error("找不到足夠的小說正文。請改用『翻譯選取的完整小說』。");
    await runFullTextJob(page.text,{url:page.url,title:page.title,chapterTitle:page.chapterTitle},"page");
  }catch(e){ await setState({state:"error",error:String(e?.message||e),progress:null}); }
}

chrome.contextMenus.onClicked.addListener((info,tab)=>{
  if(info.menuItemId==='translate-page'){ void startPageTranslation(tab); return; }
  openPanel(tab);
  if(info.menuItemId==='translate-selected-full'){ void richPageInfo(tab).then(p=>runFullTextJob(info.selectionText||"",p,"selection-full")); return; }
  const mode=info.menuItemId==='translate-direct'?'direct':info.menuItemId==='translate-novel'?'novel':null;
  if(mode) void richPageInfo(tab).then(p=>translateSelection(info.selectionText||"",mode,p));
});

chrome.commands.onCommand.addListener(command=>{
  void chrome.tabs.query({active:true,currentWindow:true}).then(([tab])=>{
    if(!tab?.id) return; if(command==='translate-page') return startPageTranslation(tab);
    const mode=command==='translate-direct'?'direct':command==='translate-novel'?'novel':null; if(!mode) return;
    openPanel(tab); return chrome.scripting.executeScript({target:{tabId:tab.id},func:()=>window.getSelection()?.toString()||""}).then(results=>translateSelection(results?.[0]?.result||"",mode,pageInfo(tab)));
  }).catch(console.error);
});

chrome.runtime.onMessage.addListener((msg,_sender,sendResponse)=>{
  if(msg?.type==='translate-page'){
    chrome.tabs.query({active:true,currentWindow:true}).then(([tab])=>startPageTranslation(tab)).then(()=>sendResponse({ok:true})).catch(e=>sendResponse({ok:false,error:String(e)})); return true;
  }
  if(msg?.type==='translate-pasted'){
    chrome.tabs.query({active:true,currentWindow:true}).then(async([tab])=>{ openPanel(tab); return runFullTextJob(msg.text||"",await richPageInfo(tab),"paste"); }).then(()=>sendResponse({ok:true})).catch(e=>sendResponse({ok:false,error:String(e)})); return true;
  }
  if(msg?.type==='open-reader'){ chrome.tabs.create({url:`${API}/reader`}); sendResponse({ok:true}); }
});
