// Production-only package smoke test. Deliberately does not import Vitest.
import {existsSync,mkdtempSync,readFileSync,rmSync,writeFileSync,mkdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
const root=process.cwd();const pkg=JSON.parse(readFileSync(join(root,'package.json'),'utf8'));
const temp=mkdtempSync(join(tmpdir(),'runtime-package-'));
function run(command,args,cwd=root){const result=spawnSync(command,args,{cwd,encoding:'utf8',env:process.env});if(result.status!==0)throw new Error(`${command} failed (${result.status}): ${result.stderr} ${result.stdout}`);return result.stdout;}
try{
 const clean=join(temp,'clean');mkdirSync(clean);
 run('npm',['install','--omit=dev','--no-audit','--no-fund',join(temp,JSON.parse(run('npm',['pack','--ignore-scripts','--json','--pack-destination',temp]))[0].filename)],clean);
 for(const bin of ['tsc','tsserver'])if(existsSync(join(clean,'node_modules','.bin',bin)))throw new Error(`unexpected consumer bin ${bin}`);
 run('npm',['install','--save-prod','--no-audit','--no-fund','typescript@7.0.2'],temp);
 const compiler=join(temp,'node_modules','.bin','tsc');
 const compilerBefore=run(compiler,['--version'],temp);
 const tar=JSON.parse(run('npm',['pack','--ignore-scripts','--json','--pack-destination',temp]))[0].filename;
 run('npm',['install','--omit=dev','--no-audit','--no-fund',join(temp,tar)],temp);
 console.log(run('npm',['ls','--omit=dev','--depth=1'],temp));
 const installed=join(temp,'node_modules',pkg.name);
 const bins=typeof pkg.bin==='string'?{[pkg.name]:pkg.bin}:pkg.bin??{};
 if(Object.keys(bins).length){for(const name of Object.keys(bins)){const help=run(join(temp,'node_modules','.bin',name),['--help'],temp);if(!help.trim())throw new Error(`${name}: installed CLI printed no help`);}}
 if(pkg.exports || pkg.main)run(process.execPath,['--input-type=module','-e',`await import(${JSON.stringify(pkg.name)});`],temp);
 if(run(compiler,['--version'],temp)!==compilerBefore)throw new Error('consumer compiler changed');
 run(process.execPath,['--input-type=module','-e',`const {transformSource}=await import(${JSON.stringify(pkg.name)});const result=transformSource('input.ts','function f(){return {content: []};}');if(!result.output.includes('resultType'))throw new Error('AST codemod failed');`],temp);
 console.log(`${pkg.name}: production install and built runtime smoke passed on ${process.version}`);
}finally{rmSync(temp,{recursive:true,force:true});}
