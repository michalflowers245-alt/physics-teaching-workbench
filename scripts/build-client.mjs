// Compose implementation layers at build time. The browser gets one explicit binding
// per function, not runtime reassignments to the original global functions.
import {readFile,writeFile,mkdir} from 'node:fs/promises';
let parse;
try {({parse}=await import('acorn'));} catch {({parse}=await import('../.build-deps/node_modules/acorn/dist/acorn.mjs'));}
const files=['app.js','gate.js','workbench.js','gate-workbench.js','client/lifecycle-core.js','client/teaching-flow.js','client/lifecycle-views.js','client/lifecycle-materials.js','client/paper-diagnosis.js','client/lifecycle-gates.js','client/physics-exam-native.js','client/teaching-production.js','client/classroom.js'];
const versions=new Map(),chunks=[],defined=new Set();
for(const [index,file]of files.entries()){
  const source=await readFile(new URL('../'+file,import.meta.url),'utf8');
  const ast=parse(source,{ecmaVersion:'latest',sourceType:'module'}),edits=[];
  const before=new Map(versions);
  for(const node of ast.body){
    if(node.type==='FunctionDeclaration'){
      const name=node.id.name,unique=name+'__layer'+index;
      versions.set(name,unique);defined.add(name);
      edits.push({start:node.id.start,end:node.id.end,text:unique});
    }else if(node.type==='ExpressionStatement'&&node.expression.type==='AssignmentExpression'&&node.expression.left.type==='Identifier'){
      const exp=node.expression,name=exp.left.name,unique=name+'__layer'+index;
      if(!versions.has(name))continue;
      if(['FunctionExpression','ArrowFunctionExpression'].includes(exp.right.type)){
        if(exp.right.type==='FunctionExpression'){
          const rhs=source.slice(exp.right.start,exp.right.end);
          const replacement=rhs.replace(/^(async\s+)?function\s*(?:[A-Za-z_$][\w$]*)?\s*\(/,(_,a)=>(a || '')+'function '+unique+'(');
          edits.push({start:node.start,end:node.end,text:replacement});
        }else edits.push({start:node.start,end:node.end,text:'const '+unique+' = '+source.slice(exp.right.start,exp.right.end)+';'});
      }else {
        let rhs=source.slice(exp.right.start,exp.right.end);
        if(exp.right.type==='CallExpression')for(const arg of [...exp.right.arguments].reverse())if(arg.type==='Identifier'&&versions.has(arg.name)){
          const a=arg.start-exp.right.start,b=arg.end-exp.right.start;rhs=rhs.slice(0,a)+versions.get(arg.name)+rhs.slice(b);
        }
        edits.push({start:node.start,end:node.end,text:'const '+unique+' = '+rhs+';'});
      }
      versions.set(name,unique);defined.add(name);
    }
    if(node.type==='VariableDeclaration')for(const item of node.declarations){
      if(item.init?.type==='ObjectExpression'&&/Original$/.test(item.id.name))for(const prop of item.init.properties){
        if(prop.shorthand&&before.has(prop.key.name))edits.push({start:prop.start,end:prop.end,text:prop.key.name+': '+before.get(prop.key.name)});
      }
    }
  }
  let output=source;
  for(const edit of edits.sort((a,b)=>b.start-a.start))output=output.slice(0,edit.start)+edit.text+output.slice(edit.end);
  chunks.push('// SOURCE: '+file+'\n'+output);
}
const aliases=[...versions].map(([name,version])=>'function '+name+'(...args) { return '+version+'.apply(this,args); }').join('\n');
const result="import * as Domain from '../shared/domain.mjs';\nimport * as Api from './api.mjs';\n"+aliases+'\n'+chunks.join('\n\n');
parse(result,{ecmaVersion:'latest',sourceType:'module'});
await mkdir(new URL('../client/',import.meta.url),{recursive:true});
await writeFile(new URL('../client/application.mjs',import.meta.url),result);
console.log('Built client: '+files.length+' modules, '+versions.size+' explicit function bindings');
