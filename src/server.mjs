import { resolve } from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';
import { connect } from './database.mjs';
import { seedDemo } from './demo.mjs';
import { createApp } from './http.mjs';

if(process.env.NODE_ENV==='production') throw new Error('Este incremento é de laboratório. Execução em produção bloqueada.');
const [major,minor]=process.versions.node.split('.').map(Number);
if(major<22||(major===22&&minor<16)) throw new Error('Use Node.js 22.16 ou superior. Para instalação nova, use a linha LTS 24.');
const port=Number(process.env.PORT??3000);
if(!Number.isInteger(port)||port<1024||port>65535) throw new Error('PORT deve ser um inteiro entre 1024 e 65535.');
const dir=resolve(process.env.JCS_DATA_DIR??'data');
mkdirSync(dir,{recursive:true,mode:0o700});
const db=connect(resolve(dir,'pdv.sqlite'));
const credentials=seedDemo(db);
if(credentials) {
  const content='ACESSOS LOCAIS DE TESTE. NÃO UTILIZAR EM PRODUÇÃO.\n\n'+credentials.map(u=>`Empresa: ${u.tenant}\nE-mail: ${u.email}\nSenha: ${u.password}\n`).join('\n');
  // Arquivo não servido por HTTP; permissões POSIX restritas, não equivalentes a ACL do Windows.
  writeFileSync(resolve(dir,'ACESSOS-LOCAIS.txt'),content,{mode:0o600,flag:'wx'});
  console.log(content);
}
const server=createApp(db);
server.on('error',error=>{ console.error('Não foi possível iniciar:',error.code??error.message); db.close(); process.exitCode=1; });
server.listen(port,'127.0.0.1',()=>{
  console.log(`\nPDV JCS · laboratório local: http://127.0.0.1:${port}`);
  console.log(`Acessos: ${resolve(dir,'ACESSOS-LOCAIS.txt')}`);
  console.log('Somente dados fictícios. Sem PIX, cartão integrado ou emissão fiscal.\n');
});
let stopping=false;
for(const signal of ['SIGINT','SIGTERM']) process.on(signal,()=>{
  if(stopping)return; stopping=true;
  server.close(()=>{db.close();process.exit(0);});
  server.closeIdleConnections();
});
