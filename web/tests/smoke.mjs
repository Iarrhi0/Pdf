import fs from 'node:fs';
const server=fs.readFileSync(new URL('../server.js',import.meta.url),'utf8');
const app=fs.readFileSync(new URL('../public/app.js',import.meta.url),'utf8');
for(const s of ['VERSION = \'4.0.0\'','/api/chapter-images','proxyPage(req,res','proxy-client-pdf'])if(!server.includes(s))throw new Error('server missing '+s);
for(const s of ['class PdfWriter','navigator.storage','READY','normalizeImage'])if(!app.includes(s))throw new Error('app missing '+s);
console.log('V4 smoke OK');
