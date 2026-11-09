import { readFailure } from "./readFailure";

type Target = {id:string;type:string;market:string;code:string;name:string};
type Receipt = {state:string;url?:string;legacyUrl?:string;message?:string};
async function read<T>(path:string, options:RequestInit={}) {
  const response=await fetch(path,{...options,cache:"no-store",signal:AbortSignal.timeout(20000)});
  const value=await response.json();
  if(!response.ok)throw Error(readFailure(value,"素材读取失败"));
  return value as T;
}

/** Publish bytes and bind the original asset ID in one server transaction. */
export async function uploadMaterialImage(file:File,item:Target) {
  const session=await read<{csrf:string}>("/api/fire/session");
  const headers={"x-csrf-token":session.csrf};
  const [catalog,scope]=await Promise.all([
    read<{revision:number}>(`/api/assets/catalog?type=${encodeURIComponent(item.type)}`),
    read<{revision:number}>("/api/admin/shared-assets",{headers})
  ]);
  const requestId=crypto.randomUUID(), form=new FormData();
  for(const [key,value] of Object.entries({kind:"asset",folder:item.type,market:item.market,code:item.code,name:item.name,
    assetId:item.id,catalogRevision:String(catalog.revision),expectedRevision:String(scope.revision),requestId,publicMetadataConfirmed:"true"}))form.set(key,value);
  form.set("file",file);
  let receipt:Receipt;
  try { receipt=await read<Receipt>("/api/admin/shared-assets/upload",{method:"POST",headers,body:form}); }
  catch(error) {
    // Never repeat a publication when the response was lost. Read that UUID only.
    try { receipt=await read<Receipt>(`/api/admin/shared-assets/operations/${requestId}`,{headers}); }
    catch { throw Error(error instanceof Error ? error.message : "上传结果尚未确认，请刷新素材核对"); }
  }
  if(receipt.state!=="completed"||!receipt.url)throw Error(receipt.message||"图片未更新");
  return {...item,url:receipt.legacyUrl||receipt.url,imageUrl:receipt.url};
}
