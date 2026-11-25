import { clientRequestId } from "./randomId";
import { readFailure } from "./readFailure";

type Target = {id:string;type:string;market:string;code:string;name:string};
type Receipt = {state:string;url?:string;legacyUrl?:string;message?:string};
class RejectedMaterialRequest extends Error {}

async function read<T>(path:string, options:RequestInit={}, acceptFailureReceipt=false) {
  const response=await fetch(path,{...options,cache:"no-store",signal:AbortSignal.timeout(20000)});
  const value=await response.json();
  if (!response.ok && !(acceptFailureReceipt && value?.state === "failed")) {
    const message = readFailure(value,"素材读取失败");
    if ([400,401,403,404,405,413,415,422,429].includes(response.status)) throw new RejectedMaterialRequest(message);
    throw new Error(message);
  }
  return value as T;
}

export class MaterialUploadPending extends Error {
  constructor(readonly requestId: string) {
    super("图片上传结果尚未确认");
  }
}

async function uploadReceipt(requestId: string, headers: Record<string, string>) {
  try {
    return await read<Receipt>(`/api/admin/shared-assets/operations/${requestId}`, {headers});
  } catch {
    throw new MaterialUploadPending(requestId);
  }
}

/** Publish bytes and bind the original asset ID in one server transaction. */
export async function uploadMaterialImage(file:File,item:Target,{ownerId, pendingRequestId}: {ownerId?:string;pendingRequestId?:string}={}) {
  const ownerHeaders: Record<string, string> = ownerId ? {"X-Alcor-Expected-Account":ownerId} : {};
  const session=await read<{csrf:string}>("/api/fire/session",{headers:ownerHeaders}).catch(error => {
    if (pendingRequestId) throw new MaterialUploadPending(pendingRequestId);
    throw error;
  });
  const headers={...ownerHeaders,"x-csrf-token":session.csrf};
  const requestId=pendingRequestId ?? clientRequestId();
  const receipt=pendingRequestId ? await uploadReceipt(requestId, headers) : await publish(file,item,requestId,headers);
  if(receipt?.state==="failed")throw Error(receipt.message||"图片未更新");
  if(receipt?.state!=="completed"||!receipt.url)throw new MaterialUploadPending(requestId);
  return {...item,url:receipt.legacyUrl||receipt.url,imageUrl:receipt.url};
}

async function publish(file:File,item:Target,requestId:string,headers:Record<string,string>) {
  const [catalog,scope]=await Promise.all([
    read<{revision:number}>(`/api/assets/catalog?type=${encodeURIComponent(item.type)}`,{headers}),
    read<{revision:number}>("/api/admin/shared-assets",{headers})
  ]);
  const form=new FormData();
  for(const [key,value] of Object.entries({kind:"asset",folder:item.type,market:item.market,code:item.code,name:item.name,
    assetId:item.id,catalogRevision:String(catalog.revision),expectedRevision:String(scope.revision),requestId,publicMetadataConfirmed:"true"}))form.set(key,value);
  form.set("file",file);
  try { return await read<Receipt>("/api/admin/shared-assets/upload",{method:"POST",headers,body:form},true); }
  catch (error) {
    if (error instanceof RejectedMaterialRequest) throw error;
    return await uploadReceipt(requestId,headers);
  }
}
