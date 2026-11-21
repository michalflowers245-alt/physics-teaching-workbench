export class ApiError extends Error { constructor(message,status,data){super(message);this.status=status;this.data=data;} }
export async function request(path,body,options={}) {
  const response=await fetch(path,{method:body===undefined?'GET':'POST',cache:'no-store',...options,headers:{...(body===undefined?{}:{'Content-Type':'application/json'}),...(options.headers || {})},body:body===undefined?undefined:JSON.stringify(body),signal:options.signal || AbortSignal.timeout(options.timeout || 150000)});
  const data=await response.json().catch(()=>({error:'服务返回了无法识别的内容'}));
  if(!response.ok)throw new ApiError(data.error || '操作失败',response.status,data);
  return data;
}
export async function upload(file,sessionId,kind='material') {
  const response=await fetch('/api/materials',{method:'POST',headers:{'Content-Type':file.type || 'application/octet-stream','X-File-Name':encodeURIComponent(file.name),'X-Session-Id':encodeURIComponent(sessionId),'X-Material-Kind':kind},body:file,signal:AbortSignal.timeout(120000)});
  const data=await response.json();if(!response.ok)throw new ApiError(data.error,response.status,data);return data;
}
export class BrowserReplica {
  constructor(){this.db=null;}
  async open(){
    if(this.db)return this.db;
    return this.db=await new Promise((resolve,reject)=>{
      const r=indexedDB.open('zhang-physics-v2',1);
      r.onupgradeneeded=()=>r.result.createObjectStore('replicas');
      r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);
    });
  }
  async read(key='current'){
    try {const db=await this.open();return await new Promise((resolve,reject)=>{const r=db.transaction('replicas').objectStore('replicas').get(key);r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});}
    catch{return null;}
  }
  async write(value,key='current'){
    const db=await this.open();return new Promise((resolve,reject)=>{const t=db.transaction('replicas','readwrite');t.objectStore('replicas').put(value,key);t.oncomplete=()=>resolve(true);t.onerror=()=>reject(t.error);});
  }
}
