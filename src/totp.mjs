import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
const ALPHABET='ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
export function totpSecret(){const bytes=randomBytes(20);let bits='',out='';for(const byte of bytes)bits+=byte.toString(2).padStart(8,'0');for(let i=0;i<bits.length;i+=5)out+=ALPHABET[parseInt(bits.slice(i,i+5).padEnd(5,'0'),2)];return out;}
function decode(value){let bits='';for(const char of value.toUpperCase()){const n=ALPHABET.indexOf(char);if(n<0)throw new Error('INVALID_BASE32');bits+=n.toString(2).padStart(5,'0');}const bytes=[];for(let i=0;i+8<=bits.length;i+=8)bytes.push(parseInt(bits.slice(i,i+8),2));return Buffer.from(bytes);}
export function totpCode(secret,time=Date.now()){const message=Buffer.alloc(8);message.writeBigUInt64BE(BigInt(Math.floor(time/30_000)));const hash=createHmac('sha1',decode(secret)).update(message).digest(),offset=hash.at(-1)&15;return String((hash.readUInt32BE(offset)&0x7fffffff)%1_000_000).padStart(6,'0');}
export function verifyTotp(secret,code,time=Date.now()){if(!/^\d{6}$/.test(String(code??'')))return false;const supplied=Buffer.from(String(code));return[-1,0,1].some(step=>timingSafeEqual(Buffer.from(totpCode(secret,time+step*30_000)),supplied));}
export function otpauthUri(secret,email){return `otpauth://totp/${encodeURIComponent(`PDV JCS:${email}`)}?secret=${secret}&issuer=${encodeURIComponent('PDV JCS')}&algorithm=SHA1&digits=6&period=30`;}

// Intervalo de 30 s do código aceito (ou null). Guardar o último intervalo usado impede reaproveitar o mesmo código.
export const currentTotpStep=(time=Date.now())=>Math.floor(time/30_000);
export function totpStep(secret,code,time=Date.now()){if(!/^\d{6}$/.test(String(code??'')))return null;const supplied=Buffer.from(String(code));for(const step of [-1,0,1]){if(timingSafeEqual(Buffer.from(totpCode(secret,time+step*30_000)),supplied))return currentTotpStep(time)+step;}return null;}
