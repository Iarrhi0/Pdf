import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { load } from 'cheerio';
import PDFDocument from 'pdfkit';
import sharp from 'sharp';

const __filename = fileURLToPath(import.meta.url);
const ROOT = path.dirname(__filename);
const PUBLIC = path.join(ROOT, 'public');
const CONFIG = path.join(ROOT, 'config');
const TMP = path.join(ROOT, 'tmp');
const APP_NAME = 'Chapter Search PDF Web';
const VERSION = '2.1.0';
const PORT = Number(process.env.PORT || 10000);
const HOST = process.env.HOST || '0.0.0.0';
const DEFAULT_CONCURRENCY = clamp(Number(process.env.CSPDF_CONCURRENCY || 2), 1, 4);
const MAX_CONCURRENCY = clamp(Number(process.env.CSPDF_MAX_CONCURRENCY || 4), 1, 4);
const PHONE_UA = 'Mozilla/5.0 (Linux; Android 13; Mobile) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Mobile Safari/537.36';
const BAD_IMAGE_TOKENS = ['logo','avatar','icon','sprite','emoji','advert','banner','tracking','pixel','favicon','header','footer','cover','thumbnail','thumb','gravatar','placeholder','loading','lazyload','blank','spacer','transparent','default-image'];
const CHAPTER_RE = /(?:chapter|chapitre|ch\.?|tome|volume|vol\.?)[\s_\-:#]*(\d+(?:\.\d+)?)/i;
const ACTIVE_STATES = new Set(['LOAD','ANALYZE','DOWNLOAD','PDF']);
const MIME = new Map([
  ['.html','text/html; charset=utf-8'],['.js','text/javascript; charset=utf-8'],['.css','text/css; charset=utf-8'],
  ['.json','application/json; charset=utf-8'],['.webmanifest','application/manifest+json; charset=utf-8'],
  ['.png','image/png'],['.jpg','image/jpeg'],['.jpeg','image/jpeg'],['.svg','image/svg+xml'],['.ico','image/x-icon']
]);

await fsp.mkdir(TMP, { recursive: true });

function clamp(n, a, b){ return Math.max(a, Math.min(b, Number.isFinite(n) ? n : a)); }
function sleep(ms){ return new Promise(r => setTimeout(r, ms)); }
function now(){ return Date.now(); }
function isHttpUrl(u){ try { const x=new URL(u); return x.protocol==='http:'||x.protocol==='https:'; } catch { return false; } }
function sameOrigin(a,b){ try { return new URL(a).origin===new URL(b).origin; } catch { return false; } }
function normText(s=''){ return s.normalize('NFKD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/[^a-z0-9]+/g,' ').replace(/\s+/g,' ').trim(); }
function safeName(s='Serie'){ return (s||'Serie').replace(/[<>:\\/*?"|]/g,'_').replace(/\s+/g,' ').trim().replace(/[. ]+$/,'').slice(0,120)||'Serie'; }
function chapterNumber(text='', url=''){
  const hay=`${text} ${decodeURIComponentSafe(url)}`;
  const m=hay.match(CHAPTER_RE); if(m) return Number(m[1]);
  try { const p=new URL(url).pathname; const x=p.match(/(?:^|[-_/])(\d+(?:\.\d+)?)(?:[-_/]|$)/); if(x && /chapter|chapitre|tome|volume|vol/i.test(hay)) return Number(x[1]); } catch {}
  return null;
}
function decodeURIComponentSafe(s){ try{return decodeURIComponent(s)}catch{return s} }
function json(res,obj,status=200){ const data=Buffer.from(JSON.stringify(obj)); res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Content-Length':data.length,'Cache-Control':'no-store','Access-Control-Allow-Origin':'*'}); res.end(data); }
async function bodyJson(req){ const chunks=[]; for await(const c of req) chunks.push(c); if(!chunks.length)return{}; return JSON.parse(Buffer.concat(chunks).toString('utf8')||'{}'); }
function fetchHeaders(extra={}){ return { 'User-Agent':PHONE_UA, 'Accept-Language':'fr-FR,fr;q=0.9,en;q=0.7', ...extra }; }
async function fetchWithTimeout(url, opts={}, timeout=25000){ const ctrl=new AbortController(); const timer=setTimeout(()=>ctrl.abort(),timeout); try { return await fetch(url,{redirect:'follow',...opts,signal:ctrl.signal}); } finally { clearTimeout(timer); } }
async function fetchHtml(url, timeout=25000){
  const r=await fetchWithTimeout(url,{headers:fetchHeaders({'Accept':'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'})},timeout);
  if(!r.ok) throw new Error(`HTTP ${r.status}`);
  const text=await r.text(); const ct=(r.headers.get('content-type')||'').toLowerCase();
  if(!ct.includes('text/html') && !/<html|<!doctype/i.test(text.slice(0,600))) throw new Error("La ressource n'est pas une page HTML");
  return { html:text, finalUrl:r.url || url, cookies:extractSetCookie(r) };
}
function extractSetCookie(r){ try { if(typeof r.headers.getSetCookie==='function') return r.headers.getSetCookie().map(x=>x.split(';')[0]).join('; '); } catch{} return ''; }
function canonicalSeriesName($, url){
  const sels=['h1','.post-title h1','.c-breadcrumb li:nth-last-child(2)','.breadcrumb li:nth-last-child(2)']; let title='';
  for(const sel of sels){ const t=$(sel).first().text().trim(); if(t){title=t;break;} }
  if(!title) title=$('title').first().text().trim() || path.basename(new URL(url).pathname);
  title=title.replace(/\s*[-–—:]?\s*(?:chapter|chapitre|tome|volume|vol\.?)\s*\d+(?:\.\d+)?\b.*$/i,'').replace(/[\s\-–—:]+$/,'').trim();
  return title||'Série';
}
function deriveSlugHint(url, series){ const parts=new URL(url).pathname.replace(/^\/+|\/+$/g,'').toLowerCase().split('/'); for(const key of ['catalogue','porncomic']){ const i=parts.indexOf(key); if(i>=0&&parts[i+1]) return parts[i+1]; } return normText(series).replace(/ /g,'-'); }
function analyzeSeriesHtml(html, baseUrl){
  const $=load(html); const series=canonicalSeriesName($,baseUrl); const slug=deriveSlugHint(baseUrl,series); const found=new Map(); const engines=[];
  const add=(el,engine,bonus=0, rawValue=null)=>{
    const txt=$(el).text().trim(); const raw=rawValue ?? $(el).attr('href') ?? $(el).attr('value') ?? ''; let href;
    try{href=new URL(raw,baseUrl).href}catch{return}
    if(!isHttpUrl(href)||!sameOrigin(href,baseUrl))return; const n=chapterNumber(txt,href); if(n==null)return;
    const p=new URL(href).pathname.toLowerCase(); let score=bonus;
    if(slug && p.includes(slug)) score+=5; if(/chapter|chapitre|tome|volume|vol/i.test(`${txt} ${p}`)) score+=3;
    if(/\/(tag|category|author|artist)\//i.test(p)) score-=5;
    const item={number:n,title:txt||`Chapitre ${n}`,url:href,engine,score}; const old=found.get(n); if(!old||item.score>old.score)found.set(n,item);
  };
  for(const sel of ['.wp-manga-chapter a[href]','.chapter-list a[href]','.chapters a[href]','.listing-chapters_wrap a[href]','.eph-num a[href]','.row-content-chapter a[href]']){
    const nodes=$(sel); if(nodes.length){ if(!engines.includes('S1'))engines.push('S1'); nodes.each((_,e)=>add(e,'S1',10)); }
  }
  let good=0; $('select option[value]').each((_,e)=>{ const raw=$(e).attr('value')||''; if(chapterNumber($(e).text(),raw)!=null){add(e,'S2',8,raw);good++;} }); if(good)engines.push('S2');
  const before=found.size; $('a[href]').each((_,e)=>{ let href; try{href=new URL($(e).attr('href')||'',baseUrl).href}catch{return} const txt=$(e).text().trim(); if(slug && !new URL(href).pathname.toLowerCase().includes(slug) && !normText(txt).replace(/ /g,'-').includes(slug)) return; add(e,'S3',3); }); if(found.size>before)engines.push('S3');
  const before4=found.size; $('script').each((_,e)=>{ const txt=$(e).html()||''; const matches=txt.match(/https?:\\?\/\\?\/[^\s"'<>\\]+/g)||[]; for(let raw of matches){ raw=raw.replace(/\\\//g,'/'); if(!sameOrigin(raw,baseUrl))continue; const n=chapterNumber('',raw); if(n==null)continue; const fake={}; const old=found.get(n); const item={number:n,title:`Chapitre ${n}`,url:raw,engine:'S4',score:1+(slug&&new URL(raw).pathname.toLowerCase().includes(slug)?5:0)}; if(!old||item.score>old.score)found.set(n,item); } }); if(found.size>before4)engines.push('S4');
  const chapters=[...found.values()].filter(x=>x.score>=3).sort((a,b)=>a.number-b.number).map(({score,...x})=>x);
  return {series,chapters,engine:`MULTI ${[...new Set(engines.length?engines:['S3'])].join('-')}`};
}
function candidateSeriesPages(html, baseUrl, series){ const $=load(html); const out=[]; const keys=['tous les chapitres','all chapters','tous les volumes','catalogue','serie','série']; $('a[href]').each((_,e)=>{ const txt=normText($(e).text()); let href; try{href=new URL($(e).attr('href')||'',baseUrl).href}catch{return} if(!sameOrigin(href,baseUrl))return; if(keys.some(k=>txt.includes(normText(k))))out.push(href); }); if(new URL(baseUrl).hostname.includes('sushiscan')){ const slug=normText(series).replace(/ /g,'-'); if(slug)out.push(new URL(`/catalogue/${slug}/`,baseUrl).href); } return [...new Set(out)].slice(0,8); }
async function analyzeSeries(url){ const first=await fetchHtml(url); let result=analyzeSeriesHtml(first.html,first.finalUrl); if(result.chapters.length<2){ for(const sUrl of candidateSeriesPages(first.html,first.finalUrl,result.series)){ try{ const f=await fetchHtml(sUrl,16000); const r=analyzeSeriesHtml(f.html,f.finalUrl); if(r.chapters.length>result.chapters.length){ result=r; result.engine+='+BREADCRUMB'; } }catch{} } } return {...result,source_url:first.finalUrl}; }
function pickImageUrl($, img, base){ for(const a of ['data-src','data-lazy-src','data-original','data-cfsrc','data-url','data-image','src']){ const u=($(img).attr(a)||'').trim(); if(u&&!u.startsWith('data:')){ try{return new URL(u.split(/\s+/)[0],base).href}catch{} } } const srcset=($(img).attr('data-srcset')||$(img).attr('srcset')||'').trim(); if(srcset){ const p=srcset.split(',').map(x=>x.trim().split(/\s+/)[0]).filter(Boolean); if(p.length){try{return new URL(p.at(-1),base).href}catch{}} } return ''; }
function badImageUrl(u){ const l=(u||'').toLowerCase(); return !isHttpUrl(u)||BAD_IMAGE_TOKENS.some(t=>l.includes(t)); }
function extractImages(html, base){ const $=load(html); const selectors=['.reading-content .page-break img','.reading-content img','.page-break img','#readerarea img','.reader-area img','.readerarea img','.ts_reader img','.chapter-content img','.chapter-images img','.container-chapter-reader img','.chapter-body img','.manga-reader img','.comic-reader img','.viewer img','.webtoon-reader img']; let best=[],bestSel=''; for(const sel of selectors){ const urls=[]; $(sel).each((_,e)=>{const u=pickImageUrl($,e,base);if(u&&!badImageUrl(u))urls.push(u)}); const uniq=[...new Set(urls)]; if(uniq.length>best.length){best=uniq;bestSel=sel;} } if(best.length>=2)return{urls:best,engine:`APK40:${bestSel}`}; const all=[]; $('img').each((_,e)=>{const u=pickImageUrl($,e,base);if(u&&!badImageUrl(u))all.push(u)}); const groups=new Map(); for(const u of [...new Set(all)]){const x=new URL(u); const key=`${x.host}|${path.posix.dirname(x.pathname)}`; if(!groups.has(key))groups.set(key,[]);groups.get(key).push(u);} if(groups.size)best=[...groups.values()].sort((a,b)=>b.length-a.length)[0]; return{urls:best,engine:'JAVA5-LITE'}; }
async function imageMeta(buf){ try{ const m=await sharp(buf,{failOn:'none'}).metadata(); const w=m.width||0,h=m.height||0; if(w<250||h<350||w*h<150000)return null; if(buf.length<12000&&w*h<500000)return null; return{width:w,height:h,format:(m.format||'').toLowerCase(),sha256:crypto.createHash('sha256').update(buf).digest('hex')}; }catch{return null;} }
let sharpBusy=false; async function toPdfImage(buf, meta){ if(meta.format==='jpeg'||meta.format==='jpg'||meta.format==='png')return buf; while(sharpBusy)await sleep(20); sharpBusy=true; try{return await sharp(buf,{failOn:'none'}).rotate().jpeg({quality:91,mozjpeg:false}).toBuffer();}finally{sharpBusy=false;} }
async function fetchImage(url, referer, cookie=''){ const headers=fetchHeaders({'Accept':'image/avif,image/webp,image/apng,image/*,*/*;q=0.8','Referer':referer}); if(cookie)headers.Cookie=cookie; let r=await fetchWithTimeout(url,{headers},22000); if(r.status===416){headers.Range='bytes=0-';r=await fetchWithTimeout(url,{headers},22000);} if(!r.ok)throw new Error(`HTTP ${r.status}`); const ab=await r.arrayBuffer(); return Buffer.from(ab); }
function downloadName(series,n){return `${safeName(series)} - Chapitre ${Number(n).toString().replace(/\.0$/,'')}.pdf`;}
function taskPublic(t){ const {timer,...p}=t; return {...p}; }
class TaskManager{
  constructor(){this.tasks=new Map();this.concurrency=DEFAULT_CONCURRENCY;this.running=0;this.totalBytes=0;this.lastBytes=0;this.lastSpeedAt=now();this.speed=0;setInterval(()=>this.tick(),150).unref();}
  setConcurrency(n){this.concurrency=clamp(Number(n),1,MAX_CONCURRENCY);}
  addMany(series,chapters){const ids=[];const exists=new Set([...this.tasks.values()].filter(t=>t.state!=='DELETED').map(t=>`${t.url}|${t.number}`));for(const c of chapters){const key=`${c.url}|${Number(c.number)}`;if(exists.has(key))continue;const id=crypto.randomBytes(5).toString('hex');this.tasks.set(id,{id,series,number:Number(c.number),title:c.title||`Chapitre ${c.number}`,url:c.url,state:'QUEUED',processed:0,total:0,valid:0,ignored:0,progress:0,speed_bps:0,error:'',output:'',engine:'',created:now(),started:0,ended:0,paused:false,cancelled:false,bytes_done:0});ids.push(id);exists.add(key);}return ids;}
  tick(){if(this.running>=this.concurrency)return;for(const t of this.tasks.values()){if(this.running>=this.concurrency)break;if(t.state==='QUEUED'){this.running++;t.state='LOAD';this.run(t).finally(()=>{this.running--;});}}}
  async waitIfPaused(t){while(t.paused&&!t.cancelled){t.state='PAUSED';await sleep(150);}if(!t.cancelled&&t.state==='PAUSED')t.state='DOWNLOAD';if(t.cancelled)throw new Error('__CANCELLED__');}
  async run(t){let tmp='';let stream=null;let pdf=null;try{t.started=now();t.state='LOAD';const page=await fetchHtml(t.url);t.url=page.finalUrl;if(t.cancelled)throw new Error('__CANCELLED__');t.state='ANALYZE';const ex=extractImages(page.html,page.finalUrl);t.engine=ex.engine;t.total=ex.urls.length;if(t.total<2)throw new Error(`Seulement ${t.total} image(s) candidate(s)`);tmp=path.join(TMP,`${t.id}.pdf.part`);pdf=new PDFDocument({autoFirstPage:false,compress:true,margin:0});stream=fs.createWriteStream(tmp);pdf.pipe(stream);const seen=new Set();let validBytes=0;let lastTaskBytes=0,lastTaskAt=now();t.state='DOWNLOAD';for(let i=0;i<ex.urls.length;i++){await this.waitIfPaused(t);const u=ex.urls[i];try{const buf=await fetchImage(u,page.finalUrl,page.cookies);const meta=await imageMeta(buf);if(!meta||seen.has(meta.sha256)){t.ignored++;}else{seen.add(meta.sha256);const img=await toPdfImage(buf,meta);const pageW=595;const pageH=Math.max(842,pageW*meta.height/Math.max(1,meta.width));pdf.addPage({size:[pageW,pageH],margin:0});pdf.image(img,0,0,{fit:[pageW,pageH],align:'center',valign:'center'});t.valid++;validBytes+=buf.length;}t.bytes_done+=buf.length;this.totalBytes+=buf.length;}catch(e){if(e.message==='__CANCELLED__')throw e;t.ignored++;}t.processed=i+1;t.progress=t.processed/Math.max(1,t.total);const ts=now();if(ts-lastTaskAt>=500){t.speed_bps=(t.bytes_done-lastTaskBytes)/((ts-lastTaskAt)/1000);lastTaskBytes=t.bytes_done;lastTaskAt=ts;}}t.state='PDF';pdf.end();await new Promise((resolve,reject)=>{stream.on('finish',resolve);stream.on('error',reject)});const ratio=t.valid/Math.max(1,t.total);const avg=validBytes/Math.max(1,t.valid);if(t.valid<2||(t.total>=5&&ratio<0.60)||(t.valid>=10&&avg<18000))throw new Error(`Qualité insuffisante: ${t.valid}/${t.total} vraies pages`);const final=path.join(TMP,`${t.id}-${downloadName(t.series,t.number)}`);await fsp.rename(tmp,final);tmp='';t.output=final;t.state='SAVED';t.ended=now();}catch(e){try{if(pdf&&!pdf._ended)pdf.end();}catch{}if(tmp)try{await fsp.rm(tmp,{force:true})}catch{}if(e.message==='__CANCELLED__'){t.state='STOPPED';t.error='Arrêté';}else{t.state='ERROR';t.error=e.message||String(e);}t.ended=now();}}
  action(id,a){const t=this.tasks.get(id);if(!t)return[false,'Tâche introuvable'];if(a==='pause'){t.paused=true;return[true,'En pause'];}if(a==='resume'){t.paused=false;if(t.state==='PAUSED')t.state='DOWNLOAD';return[true,'Reprise'];}if(a==='retry'){if(['ERROR','STOPPED','SAVED'].includes(t.state)){t.cancelled=false;t.paused=false;t.state='QUEUED';t.error='';t.output='';t.processed=t.valid=t.ignored=0;t.progress=0;t.bytes_done=0;}return[true,'Relancée'];}if(a==='cancel'){t.cancelled=true;return[true,'Arrêt demandé'];}if(a==='delete'){t.cancelled=true;this.tasks.delete(id);return[true,'Supprimée'];}return[true,'OK'];}
  stats(){const n=now(),dt=Math.max(1,n-this.lastSpeedAt);if(dt>=700){this.speed=(this.totalBytes-this.lastBytes)/(dt/1000);this.lastBytes=this.totalBytes;this.lastSpeedAt=n;}const arr=[...this.tasks.values()];return{cpu_app:Math.min(100,Number(((process.cpuUsage().user+process.cpuUsage().system)/1e6/Math.max(1,process.uptime())/Math.max(1,os.cpus().length)*100).toFixed(1))),cpu_pc:null,ram_app:process.memoryUsage().rss,ram_pc:Number(((1-os.freemem()/os.totalmem())*100).toFixed(1)),speed:this.speed,active:arr.filter(t=>ACTIVE_STATES.has(t.state)).length,down:arr.filter(t=>t.state==='DOWNLOAD').length,queued:arr.filter(t=>t.state==='QUEUED').length,errors:arr.filter(t=>t.state==='ERROR').length,concurrency:this.concurrency,max:MAX_CONCURRENCY,hosted:!!process.env.RENDER};}
}
const MANAGER=new TaskManager();
async function loadSources(){try{return JSON.parse(await fsp.readFile(path.join(CONFIG,'sources.json'),'utf8')).sources||[]}catch{return[]}}
async function searchSources(q){q=q.trim();if(!q)return[];const srcs=(await loadSources()).filter(x=>x.enabled!==false);const results=[];await Promise.all(srcs.slice(0,8).map(async src=>{try{const u=src.search.replace('{q}',encodeURIComponent(q));const f=await fetchHtml(u,12000);const $=load(f.html);const seen=new Set();$('a[href]').each((_,e)=>{if(results.length>=30)return;const txt=$(e).text().trim();let href;try{href=new URL($(e).attr('href')||'',f.finalUrl).href}catch{return}if(txt.length<2||!sameOrigin(href,src.base))return;if(!normText(txt).includes(normText(q)))return;const k=`${txt}|${href}`;if(seen.has(k))return;seen.add(k);results.push({source:src.name,title:txt.slice(0,120),url:href});});}catch{}}));return results.slice(0,30);}
function staticPath(urlPath){let p=urlPath==='/'?'/index.html':urlPath;try{p=decodeURIComponent(p)}catch{}const full=path.normalize(path.join(PUBLIC,p));return full.startsWith(PUBLIC)?full:null;}
async function serveStatic(req,res,u){const full=staticPath(u.pathname);if(!full)return json(res,{error:'Interdit'},403);try{const st=await fsp.stat(full);if(!st.isFile())throw 0;res.writeHead(200,{'Content-Type':MIME.get(path.extname(full).toLowerCase())||'application/octet-stream','Content-Length':st.size,'Cache-Control':u.pathname==='/sw.js'?'no-cache':'public, max-age=300'});fs.createReadStream(full).pipe(res);}catch{json(res,{error:'Introuvable'},404)}}
async function handler(req,res){const u=new URL(req.url,`http://${req.headers.host||'localhost'}`);if(req.method==='OPTIONS'){res.writeHead(204,{'Access-Control-Allow-Origin':'*','Access-Control-Allow-Methods':'GET,POST,OPTIONS','Access-Control-Allow-Headers':'Content-Type'});return res.end();}
  try{
    if(req.method==='GET'&&u.pathname==='/api/health')return json(res,{ok:true,app:APP_NAME,version:VERSION,runtime:'node'});
    if(req.method==='GET'&&u.pathname==='/api/tasks')return json(res,[...MANAGER.tasks.values()].sort((a,b)=>b.created-a.created).map(taskPublic));
    if(req.method==='GET'&&u.pathname==='/api/stats')return json(res,MANAGER.stats());
    if(req.method==='GET'&&u.pathname==='/api/settings')return json(res,{concurrency:MANAGER.concurrency,max:MAX_CONCURRENCY,output:'Stockage temporaire serveur',hosted:!!process.env.RENDER});
    if(req.method==='GET'&&u.pathname==='/api/search')return json(res,await searchSources(u.searchParams.get('q')||''));
    if(req.method==='GET'&&u.pathname.startsWith('/api/pdf/')){const id=u.pathname.split('/').pop();const t=MANAGER.tasks.get(id);if(!t?.output||!fs.existsSync(t.output))return json(res,{error:'PDF introuvable'},404);const st=await fsp.stat(t.output);const name=downloadName(t.series,t.number);res.writeHead(200,{'Content-Type':'application/pdf','Content-Disposition':`attachment; filename*=UTF-8''${encodeURIComponent(name)}`,'Content-Length':st.size,'Cache-Control':'no-store'});return fs.createReadStream(t.output).pipe(res);}
    if(req.method==='POST'&&u.pathname==='/api/analyze'){const b=await bodyJson(req);if(!isHttpUrl(b.url||''))return json(res,{error:'URL invalide'},400);return json(res,await analyzeSeries(String(b.url).trim()));}
    if(req.method==='POST'&&u.pathname==='/api/queue'){const b=await bodyJson(req);const ids=MANAGER.addMany(b.series||'Série',Array.isArray(b.chapters)?b.chapters:[]);return json(res,{added:ids.length,ids});}
    if(req.method==='POST'&&u.pathname==='/api/settings'){const b=await bodyJson(req);MANAGER.setConcurrency(b.concurrency);return json(res,{ok:true,concurrency:MANAGER.concurrency,max:MAX_CONCURRENCY});}
    if(req.method==='POST'&&u.pathname==='/api/open-folder')return json(res,{error:'Sur la version Web hébergée, utilise le bouton PDF pour télécharger sur ton appareil.'},400);
    const m=u.pathname.match(/^\/api\/tasks\/([a-f0-9]+)\/([a-z]+)$/);if(req.method==='POST'&&m){const[ok,message]=MANAGER.action(m[1],m[2]);return json(res,{ok,message},ok?200:404);}
    if(req.method==='GET'&&!u.pathname.startsWith('/api/'))return serveStatic(req,res,u);
    return json(res,{error:'Route inconnue'},404);
  }catch(e){console.error('[ERROR]',req.method,u.pathname,e);return json(res,{error:e?.message||String(e)},500);}
}
const server=http.createServer(handler);
server.listen(PORT,HOST,()=>console.log(`${APP_NAME} ${VERSION} -> http://${HOST}:${PORT}`));
process.on('SIGTERM',()=>server.close(()=>process.exit(0)));
