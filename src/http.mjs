import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { Auth } from './security.mjs';
import { Pos } from './pos.mjs';
import { AppError, requireThat } from './errors.mjs';

const ASSETS=new Map([
  ['/', ['index.html','text/html; charset=utf-8']],
  ['/app.mjs',['app.mjs','text/javascript; charset=utf-8']],
  ['/money.mjs',['money.mjs','text/javascript; charset=utf-8']],
  ['/style.css',['style.css','text/css; charset=utf-8']]
].map(([route,[file,type]])=>[route,{type,body:readFileSync(new URL(`../public/${file}`,import.meta.url))}]));

function send(res,status,data) {
  res.writeHead(status,{'Content-Type':'application/json; charset=utf-8'});
  res.end(JSON.stringify(data));
}
async function json(req) {
  requireThat((req.headers['content-type']??'').split(';')[0]==='application/json',415,'CONTENT_TYPE','Use application/json.');
  let size=0; const parts=[];
  for await (const chunk of req) {
    size+=chunk.length;
    requireThat(size<=32_768,413,'BODY_TOO_LARGE','Requisição muito grande.');
    parts.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(parts).toString('utf8')); }
  catch { throw new AppError(400,'INVALID_JSON','JSON inválido.'); }
}
export function createApp(db) {
  const auth=new Auth(db); const pos=new Pos(db);
  const server=createServer(async(req,res)=>{
    res.setHeader('X-Content-Type-Options','nosniff');
    res.setHeader('X-Frame-Options','DENY');
    res.setHeader('Referrer-Policy','no-referrer');
    res.setHeader('Cache-Control','no-store');
    res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'; object-src 'none'");
    try {
      const port=server.address()?.port;
      const hosts=[`127.0.0.1:${port}`,`localhost:${port}`];
      requireThat(hosts.includes(req.headers.host),403,'HOST_FORBIDDEN','Acesso permitido somente pelo endereço local indicado.');
      const origin=`http://${req.headers.host}`;
      const url=new URL(req.url,origin);
      if(req.method==='GET'&&ASSETS.has(url.pathname)) {
        const asset=ASSETS.get(url.pathname);
        res.writeHead(200,{'Content-Type':asset.type}); return res.end(asset.body);
      }
      if(req.method==='GET'&&url.pathname==='/health') return send(res,200,{status:'ok',mode:'local-test',fiscal:false});
      requireThat(url.pathname.startsWith('/api/'),404,'NOT_FOUND','Rota não encontrada.');
      const mutating=!['GET','HEAD'].includes(req.method);
      if(mutating) {
        // Protege inclusive login contra requisições de outras origens. Sem CORS liberado.
        requireThat(req.headers.origin===origin,403,'ORIGIN_FORBIDDEN','Origem da requisição não autorizada.');
      }
      if(req.method==='POST'&&url.pathname==='/api/login') {
        const result=await auth.login(await json(req),req.socket.remoteAddress);
        res.setHeader('Set-Cookie',`jcs_session=${result.token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200`);
        return send(res,200,{csrfToken:result.csrfToken});
      }
      const ctx=auth.resolve(req.headers.cookie);
      requireThat(ctx,401,'AUTH_REQUIRED','Faça login para continuar.');
      if(mutating) requireThat(req.headers['x-csrf-token']===ctx.csrfToken,403,'CSRF_FORBIDDEN','Sessão da tela inválida. Atualize a página.');
      if(req.method==='GET'&&url.pathname==='/api/me') return send(res,200,{...pos.me(ctx),csrfToken:ctx.csrfToken});
      if(req.method==='POST'&&url.pathname==='/api/logout') {
        auth.logout(ctx); res.setHeader('Set-Cookie','jcs_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0');
        return send(res,200,{ok:true});
      }
      let match;
      if(req.method==='GET'&&(match=url.pathname.match(/^\/api\/stores\/([\w-]+)\/state$/))) return send(res,200,pos.state(ctx,match[1]));
      if(req.method==='GET'&&(match=url.pathname.match(/^\/api\/sales\/([\w-]+)$/))) return send(res,200,pos.receipt(ctx,match[1]));
      if(req.method==='GET'&&(match=url.pathname.match(/^\/api\/operations\/([\w-]+)$/))) return send(res,200,pos.operation(ctx,match[1]));
      const routes={'/api/products':'createProduct','/api/cash/open':'openCash','/api/cash/close':'closeCash','/api/sales':'sell'};
      if(req.method==='POST'&&routes[url.pathname]) {
        const result=pos[routes[url.pathname]](ctx,req.headers['idempotency-key'],await json(req));
        return send(res,result.replayed?200:201,result);
      }
      throw new AppError(404,'NOT_FOUND','Rota não encontrada.');
    } catch(error) {
      if(res.headersSent) return res.end();
      if(error instanceof AppError) return send(res,error.status,{error:{code:error.code,message:error.message}});
      if(error?.errcode===5||error?.errcode===6||error?.message?.includes('database is locked'))
        return send(res,503,{error:{code:'DATABASE_BUSY',message:'Banco ocupado. Recupere a operação com a mesma chave.'}});
      // Não registrar conteúdo de requisições, senhas ou valores de cookies.
      console.error('Falha interna:',error?.code??error?.name??'UnknownError');
      send(res,500,{error:{code:'INTERNAL_ERROR',message:'Resultado incerto. Use Recuperar operação antes de tentar outra venda.'}});
    }
  });
  server.requestTimeout=15_000; server.headersTimeout=10_000;
  return server;
}
