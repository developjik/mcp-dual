// Ship the unchanged licensed runtime API, without installing compiler bins in consumer projects.
import {copyFileSync,mkdirSync,readFileSync,writeFileSync} from 'node:fs';
mkdirSync('dist/vendor/typescript', {recursive:true});
copyFileSync('node_modules/typescript-compiler-api/lib/typescript.js','dist/vendor/typescript/typescript.cjs');
copyFileSync('node_modules/typescript-compiler-api/LICENSE.txt','dist/vendor/typescript/LICENSE.txt');
const path='dist/src/codemod.js';
const source=readFileSync(path,'utf8');
if(!source.includes('"typescript-compiler-api"'))throw new Error('Compiler API import not found');
writeFileSync(path,source.replace('"typescript-compiler-api"','"../vendor/typescript/typescript.cjs"'));
copyFileSync('node_modules/typescript-compiler-api/ThirdPartyNoticeText.txt','dist/vendor/typescript/ThirdPartyNoticeText.txt');
