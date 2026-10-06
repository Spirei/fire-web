import { readFileSync } from "node:fs";
import { createPrivateKey, sign, createHash } from "node:crypto";
import { connect } from "node:http2";
export type PushEnvironment="sandbox"|"production";
export function apnsConfiguration() {
 const enabled=process.env.ALCOR_APNS_ENABLED==="true",path=process.env.ALCOR_APNS_KEY_FILE??"",keyId=process.env.ALCOR_APNS_KEY_ID??"",team=process.env.ALCOR_APNS_TEAM_ID??"",topic=process.env.ALCOR_APNS_TOPIC??"";
 const environments=(process.env.ALCOR_APNS_ENVIRONMENTS??"").split(",");
 let key:ReturnType<typeof createPrivateKey>|null=null;
 if(enabled&&/^[A-Z0-9]{10}$/.test(keyId)&&/^[A-Z0-9]{10}$/.test(team)&&/^[A-Za-z0-9.-]{3,200}$/.test(topic)&&environments.length>0&&environments.every(e=>e==="sandbox"||e==="production")){
  try{key=createPrivateKey(readFileSync(path));if(key.asymmetricKeyType!=="ec"||key.asymmetricKeyDetails?.namedCurve!=="prime256v1")key=null;}catch{/* Never expose key material/path diagnostics. */}
 }
 return {ready:!!key,key,keyId,team,topic,environments};
}
export function apnsPayload(notification:{id:string;post_id:string;group_id:string},badge:number) {
 return {aps:{alert:{title:"Alcor",body:"有一条新的动态"},sound:"default",badge,"thread-id":"alcor-feed"},alcor:{version:1,kind:"feed_post",notificationId:notification.id,postId:notification.post_id,groupId:notification.group_id}};
}
let providerToken:{key:string;at:number;token:string}|undefined;
export async function sendApns(environment:PushEnvironment,token:string,id:string,payload:unknown,guard:()=>boolean):Promise<{status:number;reason:string}> {
 const config=apnsConfiguration();if(!config.ready||!config.environments.includes(environment))return {status:0,reason:"apns_not_configured"};
 const enc=(x:unknown)=>Buffer.from(JSON.stringify(x)).toString("base64url");
 const unsigned=enc({alg:"ES256",kid:config.keyId})+"."+enc({iss:config.team,iat:Math.floor(Date.now()/1000)});
 const identity=createHash("sha256").update(config.key!.export({format:"der",type:"pkcs8"})).update(config.keyId+config.team+config.topic).digest("hex");
 if(!providerToken||providerToken.key!==identity||Date.now()-providerToken.at>50*60_000)providerToken={key:identity,at:Date.now(),token:unsigned+"."+sign("sha256",Buffer.from(unsigned),{key:config.key!,dsaEncoding:"ieee-p1363"}).toString("base64url")};
 const jwt=providerToken.token;
 const body=JSON.stringify(payload);if(Buffer.byteLength(body)>4096)return {status:0,reason:"payload_too_large"};
 // No await between final authorization/DND check and submitting the request.
 if(!guard())return {status:0,reason:"suppressed"};
 return new Promise(resolve=>{
  let done=false,status=0,data="";
  const client=connect(environment==="production"?"https://api.push.apple.com":"https://api.sandbox.push.apple.com");
  const finish=(reason:string)=>{if(done)return;done=true;clearTimeout(timer);client.destroy();resolve({status,reason});};
  const timer=setTimeout(()=>finish("unconfirmed"),10_000);
  client.on("error",()=>finish("unconfirmed"));
  const req=client.request({":method":"POST",":path":"/3/device/"+token,authorization:"bearer "+jwt,"apns-topic":config.topic,"apns-push-type":"alert","apns-priority":"10","apns-expiration":"0","apns-id":id,"apns-collapse-id":id});
  req.on("response",headers=>{status=Number(headers[":status"]);});
  req.on("data",chunk=>{if(data.length<8192)data+=chunk.toString();});
  req.on("error",()=>finish("unconfirmed"));req.on("end",()=>{let reason="";try{reason=JSON.parse(data).reason;}catch{}finish(status===200?"accepted":typeof reason==="string"&&/^[A-Za-z]{1,80}$/.test(reason)?reason:"rejected");});req.end(body);
 });
}
