import { resolve } from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createPostgresPool, validatePostgresRuntime } from './postgres.mjs';
import { createApp } from './http.mjs';

const [major,minor]=process.versions.node.split('.').map(Number);
if(major<22||(major===22&&minor<16)) throw new Error('Use Node.js 22.16 ou superior. Para instalação nova, use a linha LTS 24.');
const port=Number(process.env.PORT??3000);
if(!Number.isInteger(port)||port<1024||port>65535) throw new Error('PORT deve ser um inteiro entre 1024 e 65535.');
const production=process.env.NODE_ENV==='production';
const usePostgres=production||process.env.DATABASE_ENGINE==='postgres';
if(production && process.env.DATABASE_ENGINE!=='postgres') throw new Error('Produção exige DATABASE_ENGINE=postgres.');
let db;
let closeDb;
let accessFile;
if(usePostgres) {
  db=createPostgresPool();
  await validatePostgresRuntime(db);
  closeDb=()=>db.end();
} else {
  const [{ connect }, { seedDemo }] = await Promise.all([
    import('./database.mjs'),
    import('./demo.mjs')
  ]);
  const dir=resolve(process.env.JCS_DATA_DIR??'data');
  mkdirSync(dir,{recursive:true,mode:0o700});
  db=connect(resolve(dir,'pdv.sqlite'));
  closeDb=()=>db.close();
  const credentials=seedDemo(db);
  accessFile=resolve(dir,'ACESSOS-LOCAIS.txt');
  if(credentials) {
    const content='ACESSOS LOCAIS DE TESTE. NÃO UTILIZAR EM PRODUÇÃO.\n\n'+credentials.map(u=>`Empresa: ${u.tenant}\nE-mail: ${u.email}\nSenha: ${u.password}\n`).join('\n');
    // Arquivo não servido por HTTP; permissões POSIX restritas, não equivalentes a ACL do Windows.
    writeFileSync(accessFile,content,{mode:0o600,flag:'wx'});
    console.log(content);
  }
}
const server=createApp(db);
server.on('error',error=>{ console.error('Não foi possível iniciar:',error.code??error.message); closeDb(); process.exitCode=1; });
server.listen(port,production?'0.0.0.0':'127.0.0.1',()=>{
  const url=production?(process.env.PUBLIC_ORIGIN??`https://${process.env.RAILWAY_PUBLIC_DOMAIN}`):`http://127.0.0.1:${port}`;
  console.log(`\nPDV JCS: ${url}`);
  if(accessFile) console.log(`Acessos: ${accessFile}`);
  console.log(usePostgres?'PostgreSQL ativo.':'Laboratório local SQLite. Sem PIX, cartão integrado ou emissão fiscal.');
});
let stopping=false;
for(const signal of ['SIGINT','SIGTERM']) process.on(signal,()=>{
  if(stopping)return; stopping=true;
  server.close(async()=>{await closeDb();process.exit(0);});
  server.closeIdleConnections();
});
