import {extname} from 'node:path';
export const LIMITS={fileBytes:16*1024*1024,rows:200000,columns:128,cellChars:16000,textChars:4*1024*1024,files:1000,storageBytes:512*1024*1024};
export function fail(message,status=400){return Object.assign(new Error(message),{status});}
export function cleanName(value){if(typeof value!=='string'||!value.trim()||value.length>160||/[\x00-\x1f/\\]/.test(value)||value==='.'||value==='..')throw fail('Use a name of 1–160 characters without slashes or control characters.');return value.trim();}
function checkCell(v){v=String(v??'');if(v.length>LIMITS.cellChars)throw fail('A cell exceeds the 16,000 character limit.');return v;}
export function parseDelimited(text,delimiter=','){
 const rows=[];let row=[],cell='',quoted=false,closed=false;
 const pushCell=()=>{row.push(checkCell(cell));cell='';closed=false;if(row.length>LIMITS.columns)throw fail('Too many columns (maximum 128).');};
 const pushRow=()=>{pushCell();if(row.some(x=>x!==''))rows.push(row);row=[];if(rows.length>LIMITS.rows+1)throw fail('Too many records (maximum 200,000).');};
 for(let i=0;i<text.length;i++){const c=text[i];if(quoted){if(c==='"'){if(text[i+1]==='"'){cell+='"';i++;}else{quoted=false;closed=true;}}else cell+=c;}
 else if(c==='"'){if(cell||closed)throw fail('Malformed delimited data: unexpected quote.');quoted=true;}
 else if(c===delimiter)pushCell();else if(c==='\n'||c==='\r'){pushRow();if(c==='\r'&&text[i+1]==='\n')i++;}
 else {if(closed)throw fail('Malformed delimited data after a closing quote.');cell+=c;}
 if(cell.length>LIMITS.cellChars)throw fail('A cell exceeds the 16,000 character limit.');
 }
 if(quoted)throw fail('Malformed delimited data: unclosed quote.');if(cell||row.length||closed)pushRow();
 if(!rows.length)return {columns:[],rows:[]};const columns=rows.shift().map(x=>x.trim());
 if(columns.some(x=>!x)||new Set(columns).size!==columns.length)throw fail('Column names must be nonempty and unique.');
 if(rows.some(x=>x.length!==columns.length))throw fail('Every record must have the same number of columns as its header.');
 return {columns,rows};
}
export function extract(name,buffer){
 if(buffer.length>LIMITS.fileBytes)throw fail('File exceeds 16 MiB.',413);
 const extension=extname(name).toLowerCase();if(!['.csv','.tsv','.json','.md','.txt'].includes(extension))return {kind:'unsupported',status:'extraction unsupported',columns:[],rows:[],chunks:[],warnings:['Stored safely. This format is not extracted by this installation.']};
 let text;try{text=new TextDecoder('utf-8',{fatal:true}).decode(buffer).replace(/^\uFEFF/,'');}catch{throw fail('Supported text formats must use UTF-8 encoding.');}if(text.includes('\0'))throw fail('Binary content is not valid text.');
 if(extension==='.csv'||extension==='.tsv')return {kind:'table',status:'indexed',...parseDelimited(text,extension==='.tsv'?'\t':','),chunks:[],warnings:[]};
 if(extension==='.json'){
 let value;try{value=JSON.parse(text);}catch{throw fail('Invalid JSON.');}
 if(Array.isArray(value)&&value.length&&value.every(v=>v&&typeof v==='object'&&!Array.isArray(v))){if(value.length>LIMITS.rows)throw fail('Too many records.');const columns=[...new Set(value.flatMap(Object.keys))];if(columns.length>LIMITS.columns)throw fail('Too many columns.');return {kind:'table',status:'indexed',columns,rows:value.map(v=>columns.map(k=>checkCell(v[k]!=null&&typeof v[k]==='object'?JSON.stringify(v[k]):v[k]))),chunks:[],warnings:[]};}
 try{text=JSON.stringify(value,null,2);}catch{throw fail('JSON nesting is too deep.');}
 }
 if(text.length>LIMITS.textChars)throw fail('Text document exceeds 4 million characters.');
 const chunks=[];let heading='Document',start=1,parts=[];const lines=text.split('\n');
 const flush=(end)=>{if(parts.join('\n').trim())chunks.push({text:parts.join('\n').trim(),section:heading,lineStart:start,lineEnd:end});parts=[];};
 lines.forEach((line,i)=>{if(/^#{1,6}\s/.test(line)){flush(i);heading=line.replace(/^#+\s*/,'').slice(0,160);start=i+1;}if(parts.join('\n').length+line.length>2200){flush(i);start=i+1;}if(!parts.length)start=i+1;parts.push(line.slice(0,LIMITS.cellChars));});flush(lines.length);
 return {kind:'text',status:'indexed',text,columns:[],rows:[],chunks,warnings:[]};
}
export function inferRole(columns){const c=columns.map(x=>x.toLowerCase().replace(/[ -]/g,'_'));if(['order_id','order_date','customer_id','total','currency','status'].every(x=>c.includes(x)))return 'orders';if(['refund_id','order_id','refund_amount','currency','status'].every(x=>c.includes(x)))return 'refunds';if(['customer_id','email'].every(x=>c.includes(x)))return 'customers';if(['product_id','name','price'].every(x=>c.includes(x)))return 'products';if(['order_id','product_id','quantity','line_total'].every(x=>c.includes(x)))return 'order_items';return null;}
export function exportCSV(data){const safe=v=>{let s=String(v??'');if(/^[=+@\-\t\r]/.test(s))s="'"+s;return '"'+s.replaceAll('"','""')+'"';};return [data.columns,...data.rows].map(r=>r.map(safe).join(',')).join('\r\n');}
