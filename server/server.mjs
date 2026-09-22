import express from "express";
import OpenAI from "openai";
import dotenv from "dotenv";
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import os from "node:os";
import { fileURLToPath } from "node:url";

dotenv.config();
const ENABLE_LAN_READER = String(process.env.ENABLE_LAN_READER || "false").toLowerCase() === "true";
if (!process.env.OPENAI_API_KEY) {
  console.error("Missing OPENAI_API_KEY. Copy .env.example to .env and add your key.");
  process.exit(1);
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const LIBRARY = path.join(ROOT, "library");
const WORKS = path.join(LIBRARY, "works");
const HISTORY = path.join(LIBRARY, "history.csv");
const USAGE = path.join(LIBRARY, "usage.csv");
// GPT-5.6 Luna standard text-token rates (USD per 1M tokens).
// Kept here so the estimate is transparent and easy to update if pricing changes.
const PRICING = { input: 0.20, cachedInput: 0.02, output: 1.20 };
const GLOSSARY = path.join(ROOT, "config", "glossary.json");
const app = express();
const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
app.use(express.json({ limit: "12mb" }));
const jobs = new Map();

// LAN access policy: other devices on the same network may only read the Reader/library.
// Translation endpoints stay localhost-only so another Wi-Fi client cannot spend API credits.
function isLoopbackRequest(req) {
  const ip = String(req.socket?.remoteAddress || "");
  return ip === "127.0.0.1" || ip === "::1" || ip === "::ffff:127.0.0.1";
}
function isLanReadOnlyRoute(req) {
  if (req.method !== "GET") return false;
  return req.path === "/reader" || req.path === "/api/library" ||
    req.path.startsWith("/api/library/") || req.path === "/api/usage-summary";
}
app.use((req, res, next) => {
  if (isLoopbackRequest(req) || isLanReadOnlyRoute(req)) return next();
  return res.status(403).json({ error: "This endpoint is available only from the computer running JP Reader." });
});

async function loadGlossary() {
  try {
    const raw = await fs.readFile(GLOSSARY, "utf8");
    const data = JSON.parse(raw);
    const lines = [];
    if (data.characters && typeof data.characters === "object") {
      lines.push("[Characters / proper nouns]");
      for (const [jp, info] of Object.entries(data.characters)) {
        if (typeof info === "string") lines.push(`- ${jp} -> ${info}`);
        else {
          const bits = [`${jp} -> ${info.zh || jp}`];
          if (info.gender) bits.push(`gender: ${info.gender}`);
          if (info.note) bits.push(`note: ${info.note}`);
          lines.push(`- ${bits.join("; ")}`);
        }
      }
    }
    if (data.terms && typeof data.terms === "object") {
      lines.push("[Fixed translations]");
      for (const [jp, zh] of Object.entries(data.terms)) lines.push(`- ${jp} -> ${zh}`);
    }
    if (Array.isArray(data.rules)) {
      lines.push("[Glossary rules]");
      for (const rule of data.rules) lines.push(`- ${rule}`);
    }
    return lines.length ? `\n\nFollow this user glossary strictly when applicable. Do not mention the glossary in the output.\n${lines.join("\n")}` : "";
  } catch (err) {
    if (err?.code !== "ENOENT") console.warn("Could not load glossary.json:", err.message);
    return "";
  }
}

const prompts = {
  direct: `Translate the supplied Japanese text into natural Taiwan Traditional Chinese. Be faithful and literal where possible. Do not add commentary, explanation, interpretation, headings, or content absent from the source. Preserve paragraph breaks, dialogue, names, punctuation intent, emojis, and spoiler formatting where practical. Output only the translation.`,
  novel: `Translate the supplied Japanese prose into fluent, readable Taiwan Traditional Chinese suitable for reading as a novel. Preserve every fact, action, emotional nuance, paragraph, dialogue turn, and character relationship. You may naturally reorder syntax for Chinese readability, but do not summarize, censor, embellish, explain, or invent. Preserve names consistently. Output only the translated prose.`
};

const csv = v => `"${String(v ?? "").replaceAll('"','""')}"`;
const safeTitle = title => String(title || "未命名作品").replace(/[\r\n]+/g, " ").trim().slice(0, 300) || "未命名作品";
const normalizedUrl = raw => {
  try { const u = new URL(raw); u.hash = ""; return u.toString(); }
  catch { return String(raw || "").trim(); }
};
function sourceIdentity(rawUrl, title="") {
  const url = normalizedUrl(rawUrl);
  try {
    const u = new URL(url);
    if (u.hostname.endsWith("archiveofourown.org")) {
      const m = u.pathname.match(/^\/works\/(\d+)(?:\/chapters\/(\d+))?/);
      if (m) {
        const workNumber = m[1];
        const chapterNumber = m[2] || "work";
        return {
          site:"ao3", workKey:`ao3:work:${workNumber}`, workId:`ao3_${workNumber}`,
          chapterId:`ao3_chapter_${chapterNumber}`, chapterKey:`ao3:chapter:${chapterNumber}`,
          chapterUrl:url, chapterTitle:safeTitle(title || (chapterNumber === "work" ? "Work" : `Chapter ${chapterNumber}`))
        };
      }
    }
  } catch {}
  const hash = crypto.createHash("sha256").update(url || crypto.randomUUID()).digest("hex").slice(0,10);
  const day = new Date().toISOString().slice(0,10).replaceAll("-","");
  return {site:"web",workKey:`url:${url}`,workId:`${day}_${hash}`,chapterId:"main",chapterKey:`url:${url}`,chapterUrl:url,chapterTitle:safeTitle(title)};
}
const workIdFor = (url,title="") => sourceIdentity(url,title).workId;

async function ensureLibrary() {
  await fs.mkdir(WORKS, { recursive:true });
  try { await fs.access(HISTORY); }
  catch {
    await fs.writeFile(HISTORY, "segment_id,work_id,title,url,mode,translated_at,original_file,translated_file\n", "utf8");
  }
  try { await fs.access(USAGE); }
  catch {
    await fs.writeFile(USAGE, "timestamp,work_id,segment_id,title,mode,input_tokens,cached_input_tokens,output_tokens,total_tokens,estimated_cost_usd\n", "utf8");
  }
}

async function findExistingWork(url, title="") {
  await ensureLibrary();
  const identity = sourceIdentity(url,title);
  const directDir = path.join(WORKS, identity.workId);
  try {
    const meta = JSON.parse(await fs.readFile(path.join(directDir,"metadata.json"),"utf8"));
    return { id:identity.workId, meta, identity };
  } catch {}
  const dirs = await fs.readdir(WORKS, { withFileTypes:true });
  for (const d of dirs) {
    if (!d.isDirectory()) continue;
    try {
      const meta = JSON.parse(await fs.readFile(path.join(WORKS,d.name,"metadata.json"),"utf8"));
      if (meta.workKey === identity.workKey || (identity.site === "web" && meta.url === identity.chapterUrl)) return { id:d.name, meta, identity };
    } catch {}
  }
  return null;
}

function normalizeUsage(usage={}) {
  const input = Number(usage?.input_tokens || 0);
  const cached = Number(usage?.input_tokens_details?.cached_tokens || 0);
  const output = Number(usage?.output_tokens || 0);
  const total = Number(usage?.total_tokens || (input + output));
  // cached tokens are included in input_tokens, so charge the uncached remainder at input rate.
  const uncached = Math.max(0, input - cached);
  const estimatedCostUsd = (uncached * PRICING.input + cached * PRICING.cachedInput + output * PRICING.output) / 1_000_000;
  return { inputTokens:input, cachedInputTokens:cached, outputTokens:output, totalTokens:total, estimatedCostUsd };
}
function addUsage(a={}, b={}) {
  return {
    inputTokens:Number(a.inputTokens||0)+Number(b.inputTokens||0),
    cachedInputTokens:Number(a.cachedInputTokens||0)+Number(b.cachedInputTokens||0),
    outputTokens:Number(a.outputTokens||0)+Number(b.outputTokens||0),
    totalTokens:Number(a.totalTokens||0)+Number(b.totalTokens||0),
    estimatedCostUsd:Number(a.estimatedCostUsd||0)+Number(b.estimatedCostUsd||0)
  };
}
async function recordUsage({workId, segmentId, title, mode, usage, timestamp}) {
  const u=normalizeUsage(usage);
  await fs.appendFile(USAGE, [timestamp,workId,segmentId,title,mode,u.inputTokens,u.cachedInputTokens,u.outputTokens,u.totalTokens,u.estimatedCostUsd.toFixed(8)].map(csv).join(",")+"\n", "utf8");
  return u;
}

async function saveTranslation({ text, translation, mode, url, title, usage=null, chapterTitle="" }) {
  await ensureLibrary();
  const cleanUrl = normalizedUrl(url);
  const identity = sourceIdentity(cleanUrl, chapterTitle || title);
  const existing = cleanUrl ? await findExistingWork(cleanUrl, title) : null;
  const workId = existing?.id || identity.workId;
  const dir = path.join(WORKS, workId);
  await fs.mkdir(dir, { recursive:true });

  const now = new Date().toISOString();
  const segmentId = `${now.replace(/[-:.TZ]/g,"").slice(0,14)}_${crypto.randomBytes(3).toString("hex")}`;
  const originalFile = path.join(dir,"original.md");
  const translatedFile = path.join(dir,"translated.md");
  const metadataFile = path.join(dir,"metadata.json");
  const oldMeta = existing?.meta || {};
  // For AO3, keep the first known work title instead of replacing it with each chapter/tab title.
  const displayTitle = safeTitle(oldMeta.title || title);

  if (!existing) {
    const header = `# ${displayTitle}\n\n`;
    await fs.writeFile(originalFile, header, "utf8");
    await fs.writeFile(translatedFile, header, "utf8");
  }

  const chapters = Array.isArray(oldMeta.chapters) ? [...oldMeta.chapters] : [];
  let chapter = chapters.find(c => c.id === identity.chapterId);
  const resolvedChapterTitle = safeTitle(chapterTitle || identity.chapterTitle || title || "Chapter");
  if (!chapter) {
    chapter = {id:identity.chapterId,title:resolvedChapterTitle,url:identity.chapterUrl,createdAt:now,updatedAt:now,segmentCount:0};
    chapters.push(chapter);
    // Chapter headings are embedded in both Markdown files for portability/readability.
    const heading = `\n\n## ${resolvedChapterTitle}\n\n<!-- chapter:${identity.chapterId} source:${identity.chapterUrl} -->\n`;
    await fs.appendFile(originalFile, heading, "utf8");
    await fs.appendFile(translatedFile, heading, "utf8");
  }
  chapter.title = chapter.title || resolvedChapterTitle;
  chapter.url = identity.chapterUrl || chapter.url;
  chapter.updatedAt = now;
  chapter.segmentCount = Number(chapter.segmentCount || 0) + 1;

  const marker = `<!-- segment:${segmentId} chapter:${identity.chapterId} mode:${mode} translated_at:${now} -->`;
  await fs.appendFile(originalFile, `\n${marker}\n\n${text.trim()}\n`, "utf8");
  await fs.appendFile(translatedFile, `\n${marker}\n\n${translation.trim()}\n`, "utf8");

  const meta = {
    ...oldMeta, workId, workKey:identity.workKey, site:identity.site, title:displayTitle,
    url: oldMeta.url || cleanUrl, createdAt:oldMeta.createdAt || now, updatedAt:now,
    segmentCount:Number(oldMeta.segmentCount || 0) + 1, chapters,
    usage:addUsage(oldMeta.usage || {}, usage ? normalizeUsage(usage) : {})
  };
  await fs.writeFile(metadataFile, JSON.stringify(meta,null,2), "utf8");
  const relOrig = path.relative(LIBRARY, originalFile).replaceAll("\\","/");
  const relTrans = path.relative(LIBRARY, translatedFile).replaceAll("\\","/");
  await fs.appendFile(HISTORY, [segmentId,workId,displayTitle,cleanUrl,mode,now,relOrig,relTrans].map(csv).join(",")+"\n", "utf8");
  const usageSummary = usage ? await recordUsage({workId,segmentId,title:displayTitle,mode,usage,timestamp:now}) : normalizeUsage({});
  return { workId, segmentId, chapterId:identity.chapterId, title:displayTitle, url:cleanUrl, originalFile:relOrig, translatedFile:relTrans, usage:usageSummary };
}


function chunkText(text, maxChars=12000) {
  const paras = String(text).replace(/\r\n/g,"\n").split(/\n{2,}/).map(x=>x.trim()).filter(Boolean);
  const out=[]; let buf="";
  const push=()=>{ if(buf.trim()) out.push(buf.trim()); buf=""; };
  for(const para of paras){
    if(para.length>maxChars){
      push();
      for(let i=0;i<para.length;i+=maxChars) out.push(para.slice(i,i+maxChars));
      continue;
    }
    if(buf && buf.length+para.length+2>maxChars) push();
    buf += (buf?"\n\n":"")+para;
  }
  push(); return out;
}

async function translateChunk(text, mode, glossary, context="") {
  const continuity = context ? `\n\nContinuity context from the immediately preceding translated passage (do not output this context):\n${context.slice(-2200)}` : "";
  return client.responses.create({
    model:"gpt-5.6-luna", reasoning:{effort:"none"}, store:false,
    instructions:prompts[mode] + glossary + continuity, input:text
  });
}

async function runPageJob(jobId, payload){
  const job=jobs.get(jobId);
  try{
    const {text,url,title,chapterTitle=""}=payload; const mode="novel";
    const chunks=chunkText(text,12000); job.total=chunks.length; job.status="running";
    const glossary=await loadGlossary(); let previous=""; const translated=[]; let lastSaved=null; let jobUsage=normalizeUsage({});
    for(let i=0;i<chunks.length;i++){
      job.current=i; job.message=`正在翻譯第 ${i+1} / ${chunks.length} 段…`;
      const response=await translateChunk(chunks[i],mode,glossary,previous);
      const zh=response.output_text??""; translated.push(zh); previous=zh;
      const chunkUsage=normalizeUsage(response.usage||{}); jobUsage=addUsage(jobUsage,chunkUsage);
      lastSaved=await saveTranslation({text:chunks[i],translation:zh,mode,url,title,chapterTitle,usage:response.usage||{}});
      job.current=i+1; job.translation=translated.join("\n\n"); job.usage=jobUsage;
    }
    job.status="done"; job.message=`完成，共 ${chunks.length} 段`; job.saved=lastSaved; job.usage=jobUsage;
  }catch(err){ console.error(err); job.status="error"; job.error=err?.message||"Full-page translation failed"; job.message="翻譯失敗"; }
}

app.post("/translate-page", async (req,res)=>{
  const text=String(req.body?.text??"").trim();
  if(!text) return res.status(400).json({error:"No page text supplied"});
  if(text.length>2_000_000) return res.status(413).json({error:"Page text is too large (>2,000,000 characters)."});
  const jobId=crypto.randomUUID();
  jobs.set(jobId,{id:jobId,status:"queued",current:0,total:0,message:"排隊中…",translation:"",saved:null,error:"",usage:normalizeUsage({}),createdAt:Date.now()});
  void runPageJob(jobId,{text,url:String(req.body?.url??""),title:String(req.body?.title??""),chapterTitle:String(req.body?.chapterTitle??"")});
  res.json({jobId});
});
app.get("/jobs/:id",(req,res)=>{ const j=jobs.get(req.params.id); if(!j) return res.status(404).json({error:"Job not found"}); res.json(j); });

function parseSegments(md){
  const text=String(md||""); const re=/<!-- segment:([^\s]+)([^>]*)-->/g; const out=[]; let m; const matches=[];
  while((m=re.exec(text))) matches.push({id:m[1],attrs:m[2]||"",start:m.index,end:re.lastIndex});
  for(let i=0;i<matches.length;i++){ const x=matches[i]; const next=matches[i+1]?.start ?? text.length; const cm=x.attrs.match(/chapter:([^\s]+)/); let body=text.slice(x.end,next).trim(); body=body.replace(/\n*## [^\n]+\n+<!-- chapter:[^>]+-->\s*$/,'').trim(); out.push({id:x.id,chapterId:cm?.[1]||"main",text:body}); }
  return out;
}
async function listWorks(){
  await ensureLibrary(); const dirs=await fs.readdir(WORKS,{withFileTypes:true}); const rows=[];
  for(const d of dirs){ if(!d.isDirectory()) continue; try{ const m=JSON.parse(await fs.readFile(path.join(WORKS,d.name,"metadata.json"),"utf8")); rows.push(m); }catch{} }
  return rows.sort((a,b)=>String(b.updatedAt).localeCompare(String(a.updatedAt)));
}

app.get("/api/usage-summary", async (_req,res)=>{
  try {
    const works=await listWorks();
    const total=works.reduce((a,w)=>addUsage(a,w.usage||{}),normalizeUsage({}));
    res.json({model:"gpt-5.6-luna",pricing:PRICING,total,works:works.map(w=>({workId:w.workId,title:w.title,updatedAt:w.updatedAt,segmentCount:w.segmentCount||0,usage:w.usage||normalizeUsage({})}))});
  } catch(e) { res.status(500).json({error:e.message}); }
});
app.get("/api/library",async(_req,res)=>{ try{res.json({works:await listWorks()});}catch(e){res.status(500).json({error:e.message});} });
app.get("/api/library/:id",async(req,res)=>{ try{
  const dir=path.join(WORKS,path.basename(req.params.id)); const meta=JSON.parse(await fs.readFile(path.join(dir,"metadata.json"),"utf8"));
  const [o,t]=await Promise.all([fs.readFile(path.join(dir,"original.md"),"utf8"),fs.readFile(path.join(dir,"translated.md"),"utf8")]);
  const os=parseSegments(o),ts=parseSegments(t); const tm=new Map(ts.map(x=>[x.id,x]));
  res.json({meta,segments:os.map(x=>({id:x.id,chapterId:x.chapterId||"main",original:x.text,translated:tm.get(x.id)?.text||tm.get(x.id)||""}))});
 }catch(e){res.status(404).json({error:e.message});} });
app.get("/reader",(_req,res)=>res.type("html").send(`<!doctype html><html lang="zh-Hant"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>JP Reader 書庫</title><style>
body{margin:0;font-family:system-ui,-apple-system,"Noto Sans TC",sans-serif;background:#111210;color:#e8e6e1}header{position:sticky;top:0;background:#171816;border-bottom:1px solid #30312e;padding:14px 20px;display:flex;gap:12px;align-items:center;z-index:2;box-shadow:0 2px 12px rgba(0,0,0,.22)}header strong{font-size:18px;color:#f2f0eb}button,select{padding:8px 10px;border:1px solid #3b3d38;border-radius:8px;background:#242622;color:#e8e6e1}button:hover,select:hover{background:#2d2f2a;border-color:#555850}button:disabled{opacity:.45;cursor:not-allowed}.layout{display:grid;grid-template-columns:300px 1fr;min-height:calc(100vh - 60px)}aside{border-right:1px solid #30312e;background:#171816;padding:12px;overflow:auto}.work{padding:10px;border-radius:9px;cursor:pointer;color:#dedcd6}.work:hover,.work.active{background:#292b27}.work small{display:block;color:#9b9d96;margin-top:4px}.content{padding:28px;max-width:1100px}.title{font-size:26px;margin:0 0 6px;color:#f2f0eb}.url{font-size:12px;color:#9b9d96;word-break:break-all}.seg{margin:24px 0;padding-bottom:22px;border-bottom:1px solid #30312e;line-height:1.9;white-space:pre-wrap}.dual{display:grid;grid-template-columns:1fr 1fr;gap:28px}.jp{color:#b5b6b0}.zh{font-size:17px;color:#eeece7}a{color:#aebfd4}#usageStats{color:#a5a79f!important}@media(max-width:800px){.layout{grid-template-columns:1fr}aside{max-height:220px;border-right:0;border-bottom:1px solid #30312e}.dual{grid-template-columns:1fr}}
</style></head><body><header><strong>📚 JP Reader 書庫</strong><select id="chapter"><option value="all">全部章節</option></select><select id="view"><option value="zh">只看中文</option><option value="dual">日中對照</option><option value="jp">只看日文</option></select><button id="source" disabled>開啟原始網頁</button><span id="usageStats" style="margin-left:auto;font-size:12px;color:#666">Usage 讀取中…</span></header><div class="layout"><aside id="list">讀取中…</aside><main class="content"><h1 class="title">選一篇作品</h1><div id="meta"></div><div id="body"></div></main></div><script>
let current=null,data=null;const esc=s=>String(s??'').replace(/[&<>]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));
async function loadStats(){try{const j=await fetch('/api/usage-summary').then(r=>r.json());const u=j.total||{};document.querySelector('#usageStats').textContent='累計 '+Number(u.totalTokens||0).toLocaleString()+' tokens · 約 US$'+Number(u.estimatedCostUsd||0).toFixed(4);}catch{document.querySelector('#usageStats').textContent='Usage 無法讀取';}}
async function loadList(){const j=await fetch('/api/library').then(r=>r.json());const l=document.querySelector('#list');l.innerHTML=j.works.length?'':'尚無翻譯紀錄';j.works.forEach(w=>{const d=document.createElement('div');d.className='work';d.innerHTML='<b>'+esc(w.title)+'</b><small>'+esc(w.updatedAt||'')+' · '+((w.chapters||[]).length||1)+' 章 · '+(w.segmentCount||0)+' 段</small>';d.onclick=()=>loadWork(w.workId,d);l.appendChild(d);});}
async function loadWork(id,el){document.querySelectorAll('.work').forEach(x=>x.classList.remove('active'));el?.classList.add('active');data=await fetch('/api/library/'+encodeURIComponent(id)).then(r=>r.json());current=data.meta;document.querySelector('.title').textContent=current.title;document.querySelector('#meta').innerHTML='<div class="url">'+esc(current.url||'')+'</div>';document.querySelector('#source').disabled=!current.url;const cs=document.querySelector('#chapter');cs.innerHTML='<option value="all">全部章節</option>';const chapters=(current.chapters?.length?current.chapters:[{id:'main',title:'全文',url:current.url}]);chapters.forEach((c,i)=>{const o=document.createElement('option');o.value=c.id;o.textContent=(i+1)+'. '+(c.title||('Chapter '+(i+1)));cs.appendChild(o)});render();}
function render(){if(!data)return;const v=document.querySelector('#view').value;const ch=document.querySelector('#chapter').value;const b=document.querySelector('#body');b.innerHTML='';let lastChapter='';data.segments.filter(s=>ch==='all'||(s.chapterId||'main')===ch).forEach(s=>{if((s.chapterId||'main')!==lastChapter){lastChapter=s.chapterId||'main';const c=(current.chapters||[]).find(x=>x.id===lastChapter);if(c){const h=document.createElement('h2');h.textContent=c.title||'Chapter';h.style.marginTop='32px';b.appendChild(h);}}const e=document.createElement('section');e.className='seg';if(v==='dual')e.innerHTML='<div class="dual"><div class="jp">'+esc(s.original)+'</div><div class="zh">'+esc(s.translated)+'</div></div>';else if(v==='jp')e.innerHTML='<div class="jp">'+esc(s.original)+'</div>';else e.innerHTML='<div class="zh">'+esc(s.translated)+'</div>';b.appendChild(e);});}
document.querySelector('#view').onchange=render;document.querySelector('#chapter').onchange=render;document.querySelector('#source').onclick=()=>{const ch=document.querySelector('#chapter').value;const c=(current?.chapters||[]).find(x=>x.id===ch);const url=c?.url||current?.url;if(url)open(url,'_blank')};loadStats();loadList();
</script></body></html>`));

app.get("/health", async (_req,res)=>{
  let glossary = false;
  try { await fs.access(GLOSSARY); glossary = true; } catch {}
  res.json({ok:true, model:"gpt-5.6-luna", library:LIBRARY, glossary});
});
app.post("/translate", async (req,res) => {
  try {
    const text = String(req.body?.text ?? "").trim();
    const mode = req.body?.mode === "direct" ? "direct" : "novel";
    const url = String(req.body?.url ?? "");
    const title = String(req.body?.title ?? "");
    const chapterTitle = String(req.body?.chapterTitle ?? "");
    if (!text) return res.status(400).json({error:"No text supplied"});
    if (text.length > 60000) return res.status(413).json({error:"Selection is too long. Select a smaller passage."});

    const glossary = await loadGlossary();
    const response = await client.responses.create({
      model:"gpt-5.6-luna", reasoning:{effort:"none"}, store:false,
      instructions:prompts[mode] + glossary, input:text
    });
    const translation = response.output_text ?? "";
    const saved = await saveTranslation({ text, translation, mode, url, title, chapterTitle, usage:response.usage ?? {} });
    res.json({ translation, usage:normalizeUsage(response.usage ?? {}), saved });
  } catch (err) {
    console.error(err);
    res.status(err?.status || 500).json({error:err?.message || "Translation failed"});
  }
});

const port = Number(process.env.PORT || 8787);
function lanIPv4Addresses() {
  const found = [];
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const info of entries || []) {
      if (info.family === "IPv4" && !info.internal) found.push(info.address);
    }
  }
  return [...new Set(found)];
}
const bindHost = ENABLE_LAN_READER ? "0.0.0.0" : "127.0.0.1";
app.listen(port, bindHost, () => {
  console.log(`JP Translator server: http://127.0.0.1:${port}`);
  console.log(`Reader (this PC):    http://127.0.0.1:${port}/reader`);
  if (ENABLE_LAN_READER) {
    const ips = lanIPv4Addresses();
    if (ips.length) {
      console.log("Reader (same Wi-Fi, read-only):");
      for (const ip of ips) console.log(`  http://${ip}:${port}/reader`);
    } else console.log("Reader (same Wi-Fi): no LAN IPv4 address detected");
  } else {
    console.log("Reader (same Wi-Fi): disabled (set ENABLE_LAN_READER=true in .env to enable)");
  }
  console.log(`Library: ${LIBRARY}`);
});
