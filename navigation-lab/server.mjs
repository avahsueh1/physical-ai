import http from 'node:http';
import {readFile} from 'node:fs/promises';
const allowed={'/':'index.html','/engine.js':'engine.js','/app.js':'app.js','/style.css':'style.css'};
http.createServer(async(req,res)=>{const file=allowed[new URL(req.url,'http://localhost').pathname];if(!file){res.writeHead(404);res.end();return;}try{const data=await readFile(new URL(file,import.meta.url));res.setHeader('Content-Type',file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':'text/html');res.end(data);}catch{res.writeHead(500);res.end('Unable to read file');}}).listen(8765,'127.0.0.1',()=>console.log('Navigation lab: http://127.0.0.1:8765'));
