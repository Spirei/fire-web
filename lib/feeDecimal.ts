import { RecordsError } from './recordsContract';
const gcd=(a:bigint,b:bigint):bigint=>b?gcd(b,a%b):a<0n?-a:a;
/** Bounded exact base-ten arithmetic; conversion to SQLite REAL happens only at the ledger boundary. */
export class FeeDecimal {
  readonly n:bigint;readonly d:bigint;
  constructor(n:bigint,d=1n){if(!d)throw new RecordsError('金额除数无效');const g=gcd(n,d);this.n=n/g*(d<0n?-1n:1n);this.d=(d<0n?-d:d)/g;}
  static from(v:unknown){
    if(typeof v!=='string'&&typeof v!=='number')throw new RecordsError('须提供精确十进制金额');
    const s=typeof v==='number'&&String(v).includes('e')&&Math.abs(v)<1?v.toFixed(16).replace(/0+$/,'').replace(/\.$/,''):String(v);if(!/^-?\d{1,13}(?:\.\d{1,16})?$/.test(s))throw new RecordsError('金额精度或范围无效');
    const [a,b='']=s.split('.');return new FeeDecimal(BigInt(a+b),10n**BigInt(b.length));
  }
  add(b:FeeDecimal){return new FeeDecimal(this.n*b.d+b.n*this.d,this.d*b.d);}
  sub(b:FeeDecimal){return this.add(new FeeDecimal(-b.n,b.d));}
  mul(b:FeeDecimal){return new FeeDecimal(this.n*b.n,this.d*b.d);}
  div(b:FeeDecimal){return new FeeDecimal(this.n*b.d,this.d*b.n);}
  cmp(b:FeeDecimal){const n=this.n*b.d-b.n*this.d;return n<0n?-1:n>0n?1:0;}
  min(b:FeeDecimal){return this.cmp(b)<0?this:b;}
  max(b:FeeDecimal){return this.cmp(b)>0?this:b;}
  round(digits=2,up=false){const p=10n**BigInt(digits),n=this.n*p,sign=n<0n?-1n:1n,a=n*sign,q=a/this.d,r=a%this.d;return new FeeDecimal((q+(up?r>0n?1n:0n:r*2n>=this.d?1n:0n))*sign,p);}
  number(){const n=Number(this.n)/Number(this.d);if(!Number.isFinite(n)||Math.abs(n)>1e12)throw new RecordsError('金额超出支持范围');return n||0;}
  exact(digits=8){return this.cmp(this.round(digits))===0;}
}
export const decimal=FeeDecimal.from;
export function feeNumber(v:unknown,zero=false){const n=decimal(v);if(n.cmp(decimal(0))<(zero?0:1)||n.cmp(decimal('1000000000000'))>0||!n.exact(8))throw new RecordsError('金额须在范围内且至多八位小数');return n;}
export const feeSum=(values:FeeDecimal[])=>values.reduce((a,b)=>a.add(b),decimal(0));
