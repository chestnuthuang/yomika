const t=document.querySelector('#translation'),s=document.querySelector('#source'),status=document.querySelector('#status'),err=document.querySelector('#error'),saved=document.querySelector('#saved');
const usage=document.querySelector('#usage');
const pw=document.querySelector('#progressWrap'),p=document.querySelector('#progress'),pt=document.querySelector('#progressText'),pn=document.querySelector('#progressNum');
const paste=document.querySelector('#pasteText'),pasteCount=document.querySelector('#pasteCount'); let currentMode='novel';
async function render(){
 const d=await chrome.storage.local.get(['state','source','translation','error','mode','saved','progress','fullPage','usage']); s.textContent=d.source||'';
 const busy=['loading','extracting','preparing'].includes(d.state); t.textContent=d.translation || (busy?'處理中…':'短文可反白後按 Alt+T；長篇可整篇反白後用右鍵選單。'); t.classList.toggle('loading',busy&&!d.translation);
 status.textContent=d.state==='extracting'?'擷取正文中':d.state==='preparing'?'準備長篇':d.state==='loading'?'GPT 翻譯中':d.state==='done'?'完成':d.state==='error'?'發生錯誤':'等待文字';
 err.textContent=d.error||''; const u=d.usage; usage.textContent=u?.totalTokens?`本次 ${Number(u.totalTokens).toLocaleString()} tokens · input ${Number(u.inputTokens||0).toLocaleString()} / output ${Number(u.outputTokens||0).toLocaleString()} · 約 US$${Number(u.estimatedCostUsd||0).toFixed(5)}`:''; saved.textContent=d.saved?.workId?`✓ 已保存 · ${d.saved.title}`:'';
 const pr=d.progress; pw.hidden=!pr; if(pr){pt.textContent=pr.message||'處理中…';pn.textContent=pr.total?`${pr.current}/${pr.total}`:'';p.max=Math.max(pr.total||1,1);p.value=Math.min(pr.current||0,p.max);}
 currentMode=d.mode||currentMode; document.querySelectorAll('.tabs button').forEach(b=>b.classList.toggle('active',b.dataset.mode===currentMode));
}
chrome.storage.onChanged.addListener(render); render();
document.querySelector('#copy').onclick=async()=>{if(t.textContent) await navigator.clipboard.writeText(t.textContent)};
document.querySelector('#page').onclick=()=>chrome.runtime.sendMessage({type:'translate-page'});
document.querySelector('#reader').onclick=()=>chrome.runtime.sendMessage({type:'open-reader'});
document.querySelectorAll('.tabs button').forEach(b=>b.onclick=()=>{currentMode=b.dataset.mode;document.querySelectorAll('.tabs button').forEach(x=>x.classList.toggle('active',x===b));});
paste.addEventListener('input',()=>pasteCount.textContent=`${paste.value.length.toLocaleString()} 字`);
document.querySelector('#pasteClear').onclick=()=>{paste.value='';paste.dispatchEvent(new Event('input'));};
document.querySelector('#pasteGo').onclick=()=>{const text=paste.value.trim();if(!text){err.textContent='請先貼上日文小說。';return;} chrome.runtime.sendMessage({type:'translate-pasted',text});};
