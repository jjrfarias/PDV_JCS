import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
for(const dir of ['src','public','tests'])for(const file of readdirSync(dir).filter(n=>n.endsWith('.mjs'))){
 const result=spawnSync(process.execPath,['--check',`${dir}/${file}`],{stdio:'inherit'});
 if(result.status!==0)process.exit(result.status??1);
}
console.log('Sintaxe verificada.');
