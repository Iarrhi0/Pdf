import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { load } from 'cheerio';

const __filename = fileURLToPath(import.meta.url);
const ROOT = path.dirname(__filename);
const PUBLIC = path.join(ROOT, 'public');
const CONFIG = path.join(ROOT, 'config');
const APP_NAME = 'Chapter Search PDF Web';
const VERSION = '4.0.0';
const PORT = Number(process.env.PORT || 10000);
const HOST = process.env.HOST || '0.0.0.0';
const PROXY_MAX = clamp(Number(process.env.CSPDF_PROXY_CONCURRENCY || 4), 1, 6);
const PHONE_UA = 'Mozilla/5.0 (Linux; Android 13; Mobile) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Mobile Safari/537.36';
const BAD_IMAGE_TOKENS = ['logo','avatar','icon','sprite','emoji','advert','banner','tracking','pixel','favicon','header','footer','cover','thumbnail','thumb','gravatar','placeholder','loading','lazyload','blank','spacer','transparent','default-image'];
const CHAPTER_RE = /(?:chapter|chapitre|ch\.?|tome|volume|vol\.?)[\s_\-:#]*(\d+(?:\.\d+)?)/i;
const MIME = new Map([
  ['.html','text/html; charset=utf-8'],['.js','text/javascript; charset=utf-8'],['.css','text/css; charset=utf-8'],
  ['.json','application/json; charset=utf-8'],['.webmanifest','application/manifest+json; charset=utf-8'],
  ['.png','image/png'],['.jpg','image/jpeg'],['.jpeg','image/jpeg'],['.svg','image/svg+xml'],['.ico','image/x-icon']
]);

function clamp(n,a,b){ return Math.max(a,Math.min(b,Number.isFinite(n)?n:a)); }
function now(){ return Date.now(); }
function isHttpUrl(u){ try{ const x=new URL(u); return x.protocol==='http:'||x.protocol==='https:'; }catch{return false;} }
function sameOrigin(a,b){ try{return new URL(a).origin===new URL(b).origin}catch{return false;} }
function normText(s=''){return s.normalize('NFKD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/[^a-z0-9]+/g,' ').replace(/\s+/g,' ').trim();}
function decodeURIComponentSafe(s){try{return decodeURIComponent(s)}catch{return s}}
function json(res,obj,status=200,extra={}){const data=Buffer.from(JSON.stringify(obj));res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Content-Length':data.length,'Cache-Control':'no-store','Access-Control-Allow-Origin':'*',...extra});res.end(data);}
async function bodyJson(req){const chunks=[];for await(const c of req)chunks.push(c);if(!chunks.length)return{};return JSON.parse(Buffer.concat(chunks).toString('utf8')||'{}');}
function fetchHeaders(extra={}){return {'User-Agent':PHONE_UA,'Accept-Language':'fr-FR,fr;q=0.9,en;q=0.7',...extra};}
async function fetchWithTimeout(url,opts={},timeout=25000){const ctrl=new AbortController();const timer=setTimeout(()=>ctrl.abort(),timeout);try{return await fetch(url,{redirect:'follow',...opts,signal:ctrl.signal});}finally{clearTimeout(timer);}}
async function fetchHtml(url,timeout=25000){const r=await fetchWithTimeout(url,{headers:fetchHeaders({'Accept':'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'})},timeout);if(!r.ok)throw new Error(`HTTP ${r.status}`);const text=await r.text();const ct=(r.headers.get('content-type')||'').toLowerCase();if(!ct.includes('text/html')&&!/<html|<!doctype/i.test(text.slice(0,600)))throw new Error("La ressource n'est pas une page HTML");return{html:text,finalUrl:r.url||url,cookies:extractSetCookie(r)};}
function extractSetCookie(r){try{if(typeof r.headers.getSetCookie==='function')return r.headers.getSetCookie().map(x=>x.split(';')[0]).join('; ');}catch{}return '';}
function chapterNumber(text='',url=''){const hay=`${text} ${decodeURIComponentSafe(url)}`;const m=hay.match(CHAPTER_RE);if(m)return Number(m[1]);try{const p=new URL(url).pathname;const x=p.match(/(?:^|[-_/])(\d+(?:\.\d+)?)(?:[-_/]|$)/);if(x&&/chapter|chapitre|tome|volume|vol/i.test(hay))return Number(x[1]);}catch{}return null;}
function canonicalSeriesName($,url){const sels=['h1','.post-title h1','.c-breadcrumb li:nth-last-child(2)','.breadcrumb li:nth-last-child(2)'];let title='';for(const sel of sels){const t=$(sel).first().text().trim();if(t){title=t;break;}}if(!title)title=$('title').first().text().trim()||path.basename(new URL(url).pathname);title=title.replace(/\s*[-–—:]?\s*(?:chapter|chapitre|tome|volume|vol\.?)\s*\d+(?:\.\d+)?\b.*$/i,'').replace(/[\s\-–—:]+$/,'').trim();return title||'Série';}
function deriveSlugHint(url,series){const parts=new URL(url).pathname.replace(/^\/+|\/+$/g,'').toLowerCase().split('/');for(const key of ['catalogue','porncomic']){const i=parts.indexOf(key);if(i>=0&&parts[i+1])return parts[i+1];}return normText(series).replace(/ /g,'-');}
function analyzeSeriesHtml(html,baseUrl){const $=load(html);const series=canonicalSeriesName($,baseUrl),slug=deriveSlugHint(baseUrl,series),found=new Map(),engines=[];const add=(el,engine,bonus=0,rawValue=null)=>{const txt=$(el).text().trim(),raw=rawValue??$(el).attr('href')??$(el).attr('value')??'';let href;try{href=new URL(raw,baseUrl).href}catch{return}if(!isHttpUrl(href)||!sameOrigin(href,baseUrl))return;const n=chapterNumber(txt,href);if(n==null)return;const p=new URL(href).pathname.toLowerCase();let score=bonus;if(slug&&p.includes(slug))score+=5;if(/chapter|chapitre|tome|volume|vol/i.test(`${txt} ${p}`))score+=3;if(/\/(tag|category|author|artist)\//i.test(p))score-=5;const item={number:n,title:txt||`Chapitre ${n}`,url:href,engine,score};const old=found.get(n);if(!old||item.score>old.score)found.set(n,item);};
for(const sel of ['.wp-manga-chapter a[href]','.chapter-list a[href]','.chapters a[href]','.listing-chapters_wrap a[href]','.eph-num a[href]','.row-content-chapter a[href]']){const nodes=$(sel);if(nodes.length){if(!engines.includes('S1'))engines.push('S1');nodes.each((_,e)=>add(e,'S1',10));}}
let good=0;$('select option[value]').each((_,e)=>{const raw=$(e).attr('value')||'';if(chapterNumber($(e).text(),raw)!=null){add(e,'S2',8,raw);good++;}});if(good)engines.push('S2');
const before=found.size;$('a[href]').each((_,e)=>{let href;try{href=new URL($(e).attr('href')||'',baseUrl).href}catch{return}const txt=$(e).text().trim();if(slug&&!new URL(href).pathname.toLowerCase().includes(slug)&&!normText(txt).replace(/ /g,'-').includes(slug))return;add(e,'S3',3);});if(found.size>before)engines.push('S3');
const before4=found.size;$('script').each((_,e)=>{const txt=$(e).html()||'';const matches=txt.match(/https?:\\?\/\\?\/[^\s"'<>\\]+/g)||[];for(let raw of matches){raw=raw.replace(/\\\//g,'/');if(!sameOrigin(raw,baseUrl))continue;const n=chapterNumber('',raw);if(n==null)continue;const old=found.get(n),item={number:n,title:`Chapitre ${n}`,url:raw,engine:'S4',score:1+(slug&&new URL(raw).pathname.toLowerCase().includes(slug)?5:0)};if(!old||item.score>old.score)found.set(n,item);}});if(found.size>before4)engines.push('S4');
const chapters=[...found.values()].filter(x=>x.score>=3).sort((a,b)=>a.number-b.number).map(({score,...x})=>x);return{series,chapters,engine:`MULTI ${[...new Set(engines.length?engines:['S3'])].join('-')}`};}
function candidateSeriesPages(html,baseUrl,series){const $=load(html),out=[],keys=['tous les chapitres','all chapters','tous les volumes','catalogue','serie','série'];$('a[href]').each((_,e)=>{const txt=normText($(e).text());let href;try{href=new URL($(e).attr('href')||'',baseUrl).href}catch{return}if(!sameOrigin(href,baseUrl))return;if(keys.some(k=>txt.includes(normText(k))))out.push(href);});if(new URL(baseUrl).hostname.includes('sushiscan')){const slug=normText(series).replace(/ /g,'-');if(slug)out.push(new URL(`/catalogue/${slug}/`,baseUrl).href);}return[...new Set(out)].slice(0,8);}
async function analyzeSeries(url){const first=await fetchHtml(url);let result=analyzeSeriesHtml(first.html,first.finalUrl);if(result.chapters.length<2){for(const sUrl of candidateSeriesPages(first.html,first.finalUrl,result.series)){try{const f=await fetchHtml(sUrl,16000),r=analyzeSeriesHtml(f.html,f.finalUrl);if(r.chapters.length>result.chapters.length){result=r;result.engine+='+BREADCRUMB';}}catch{}}}return{...result,source_url:first.finalUrl};}
function pickImageUrl($,img,base){for(const a of ['data-src','data-lazy-src','data-original','data-cfsrc','data-url','data-image','src']){const u=($(img).attr(a)||'').trim();if(u&&!u.startsWith('data:')){try{return new URL(u.split(/\s+/)[0],base).href}catch{}}}const srcset=($(img).attr('data-srcset')||$(img).attr('srcset')||'').trim();if(srcset){const p=srcset.split(',').map(x=>x.trim().split(/\s+/)[0]).filter(Boolean);if(p.length){try{return new URL(p.at(-1),base).href}catch{}}}return '';}
function badImageUrl(u){const l=(u||'').toLowerCase();return!isHttpUrl(u)||BAD_IMAGE_TOKENS.some(t=>l.includes(t));}
function extractImages(html,base){const $=load(html);const selectors=['.reading-content .page-break img','.reading-content img','.page-break img','#readerarea img','.reader-area img','.readerarea img','.ts_reader img','.chapter-content img','.chapter-images img','.container-chapter-reader img','.chapter-body img','.manga-reader img','.comic-reader img','.viewer img','.webtoon-reader img'];let best=[],bestSel='';for(const sel of selectors){const urls=[];$(sel).each((_,e)=>{const u=pickImageUrl($,e,base);if(u&&!badImageUrl(u))urls.push(u)});const uniq=[...new Set(urls)];if(uniq.length>best.length){best=uniq;bestSel=sel;}}if(best.length>=2)return{urls:best,engine:`APK40:${bestSel}`};const all=[];$('img').each((_,e)=>{const u=pickImageUrl($,e,base);if(u&&!badImageUrl(u))all.push(u)});const groups=new Map();for(const u of [...new Set(all)]){const x=new URL(u),key=`${x.host}|${path.posix.dirname(x.pathname)}`;if(!groups.has(key))groups.set(key,[]);groups.get(key).push(u);}if(groups.size)best=[...groups.values()].sort((a,b)=>b.length-a.length)[0];return{urls:best,engine:'JAVA5-LITE'};}

const sessions=new Map();
function makeSession(referer,cookie,urls){const id=crypto.randomBytes(12).toString('hex');sessions.set(id,{referer,cookie,urls,created:now(),last:now()});return id;}
setInterval(()=>{const cutoff=now()-30*60*1000;for(const[id,s]of sessions)if(s.last<cutoff)sessions.delete(id);},5*60*1000).unref();
let proxyActive=0;const proxyWait=[];
async function acquireProxy(){if(proxyActive<PROXY_MAX){proxyActive++;return;}await new Promise(r=>proxyWait.push(r));proxyActive++;}
function releaseProxy(){proxyActive--;const r=proxyWait.shift();if(r)r();}
async function prepareChapter(url){const page=await fetchHtml(url);const ex=extractImages(page.html,page.finalUrl);if(ex.urls.length<2)throw new Error(`Seulement ${ex.urls.length} image(s) candidate(s)`);const session=makeSession(page.finalUrl,page.cookies,ex.urls);return{session,count:ex.urls.length,engine:ex.engine,referer:page.finalUrl};}
async function proxyPage(req,res,sid,index){const s=sessions.get(sid);if(!s||!Number.isInteger(index)||index<0||index>=s.urls.length)return json(res,{error:'SESSION_EXPIRED'},404,{'X-CSPDF-Session':'expired'});s.last=now();await acquireProxy();try{const headers=fetchHeaders({'Accept':'image/avif,image/webp,image/apng,image/*,*/*;q=0.8','Referer':s.referer});if(s.cookie)headers.Cookie=s.cookie;let r=await fetchWithTimeout(s.urls[index],{headers},28000);if(r.status===416){headers.Range='bytes=0-';r=await fetchWithTimeout(s.urls[index],{headers},28000);}if(!r.ok)return json(res,{error:`HTTP ${r.status}`},502);const ct=(r.headers.get('content-type')||'application/octet-stream').toLowerCase();if((ct.startsWith('text/')||ct.includes('html'))&&!ct.startsWith('image/'))return json(res,{error:`Contenu non-image (${ct})`},502);const out={'Content-Type':ct,'Cache-Control':'no-store','Access-Control-Allow-Origin':'*','X-CSPDF-Index':String(index)};const len=r.headers.get('content-length');if(len)out['Content-Length']=len;res.writeHead(200,out);if(!r.body)return res.end();await pipeline(Readable.fromWeb(r.body),res);}catch(e){if(!res.headersSent)json(res,{error:e?.message||String(e)},502);else try{res.destroy()}catch{}}finally{releaseProxy();}}
async function loadSources(){try{return JSON.parse(await fsp.readFile(path.join(CONFIG,'sources.json'),'utf8')).sources||[]}catch{return[]}}
async function searchSources(q){q=q.trim();if(!q)return[];const srcs=(await loadSources()).filter(x=>x.enabled!==false),results=[];await Promise.all(srcs.slice(0,8).map(async src=>{try{const u=src.search.replace('{q}',encodeURIComponent(q)),f=await fetchHtml(u,12000),$=load(f.html),seen=new Set();$('a[href]').each((_,e)=>{if(results.length>=30)return;const txt=$(e).text().trim();let href;try{href=new URL($(e).attr('href')||'',f.finalUrl).href}catch{return}if(txt.length<2||!sameOrigin(href,src.base)||!normText(txt).includes(normText(q)))return;const k=`${txt}|${href}`;if(seen.has(k))return;seen.add(k);results.push({source:src.name,title:txt.slice(0,120),url:href});});}catch{}}));return results.slice(0,30);}
function staticPath(urlPath){let p=urlPath==='/'?'/index.html':urlPath;try{p=decodeURIComponent(p)}catch{}const full=path.normalize(path.join(PUBLIC,p));return full.startsWith(PUBLIC)?full:null;}
async function serveStatic(req,res,u){const full=staticPath(u.pathname);if(!full)return json(res,{error:'Interdit'},403);try{const st=await fsp.stat(full);if(!st.isFile())throw 0;res.writeHead(200,{'Content-Type':MIME.get(path.extname(full).toLowerCase())||'application/octet-stream','Content-Length':st.size,'Cache-Control':u.pathname==='/sw.js'?'no-cache':'public, max-age=300'});fs.createReadStream(full).pipe(res);}catch{json(res,{error:'Introuvable'},404)}}
async function handler(req,res){const u=new URL(req.url,`http://${req.headers.host||'localhost'}`);if(req.method==='OPTIONS'){res.writeHead(204,{'Access-Control-Allow-Origin':'*','Access-Control-Allow-Methods':'GET,POST,OPTIONS','Access-Control-Allow-Headers':'Content-Type'});return res.end();}try{
if(req.method==='GET'&&u.pathname==='/api/health')return json(res,{ok:true,app:APP_NAME,version:VERSION,mode:'proxy-client-pdf'});
if(req.method==='GET'&&u.pathname==='/api/stats')return json(res,{ram_app:process.memoryUsage().rss,cpu_app:Number(((process.cpuUsage().user+process.cpuUsage().system)/1e6/Math.max(1,process.uptime())/Math.max(1,os.cpus().length)*100).toFixed(1)),proxy_active:proxyActive,proxy_max:PROXY_MAX,sessions:sessions.size});
if(req.method==='GET'&&u.pathname==='/api/search')return json(res,await searchSources(u.searchParams.get('q')||''));
if(req.method==='POST'&&u.pathname==='/api/analyze'){const b=await bodyJson(req);if(!isHttpUrl(b.url||''))return json(res,{error:'URL invalide'},400);return json(res,await analyzeSeries(String(b.url).trim()));}
if(req.method==='POST'&&u.pathname==='/api/chapter-images'){const b=await bodyJson(req);if(!isHttpUrl(b.url||''))return json(res,{error:'URL invalide'},400);return json(res,await prepareChapter(String(b.url).trim()));}
const pm=u.pathname.match(/^\/api\/page\/([a-f0-9]{24})\/(\d+)$/);if(req.method==='GET'&&pm)return proxyPage(req,res,pm[1],Number(pm[2]));
if(req.method==='GET'&&!u.pathname.startsWith('/api/'))return serveStatic(req,res,u);
return json(res,{error:'Route inconnue'},404);
}catch(e){console.error('[ERROR]',req.method,u.pathname,e);return json(res,{error:e?.message||String(e)},500);}}
const server=http.createServer(handler);server.requestTimeout=45000;server.headersTimeout=50000;server.keepAliveTimeout=7000;server.listen(PORT,HOST,()=>console.log(`${APP_NAME} ${VERSION} -> http://${HOST}:${PORT}`));process.on('SIGTERM',()=>server.close(()=>process.exit(0)));
