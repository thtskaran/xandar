import {readdir} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
async function walk(path){for(const entry of await readdir(path,{withFileTypes:true})){if(['node_modules','.git','vendor'].includes(entry.name))continue;const file=`${path}/${entry.name}`;if(entry.isDirectory())await walk(file);else if(/\.(mjs|js)$/.test(file)){const run=spawnSync(process.execPath,['--check',file],{stdio:'inherit'});if(run.status)process.exit(run.status);}}}
await walk('.');console.log('All application JavaScript syntax checks passed.');
