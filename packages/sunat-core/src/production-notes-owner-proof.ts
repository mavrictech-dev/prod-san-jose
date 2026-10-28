import { createHmac, timingSafeEqual } from 'node:crypto';
import { constants,openSync,lstatSync,fstatSync,readSync,realpathSync,closeSync } from 'node:fs';
import { isAbsolute,resolve } from 'node:path';
import type { ProductionNotesOwnerProof } from '@factuez/contracts';
import { fiscalSnapshotSha256 } from './fiscal-note';
/** Dedicated private Billing/SUNAT authentication key, never a client JWT, SOL or P12 secret.
 * Mount the same service-owned 32-byte hex key file into these two services only. */
function key(explicit?: Buffer) {
    if (explicit) {
        if (explicit.length !== 32)
            throw Error('Clave de atestación inválida');
        return Buffer.from(explicit);
    }
    const configured=process.env.PRODUCTION_NOTES_OWNER_KEY_FILE;
    let fd:number|undefined;let bytes:Buffer|undefined;
    const samePath=(a:string,b:string)=>process.platform==='win32'?a.toLowerCase()===b.toLowerCase():a===b;
    try {
        if(typeof configured!=='string'||!isAbsolute(configured)||configured.includes('\0')||configured.length>4096)throw Error();
        const path=resolve(configured),before=lstatSync(path);
        if(!before.isFile()||before.isSymbolicLink()||before.nlink!==1||before.size<64||before.size>128||!samePath(realpathSync(path),path)||
            process.platform!=='win32'&&(before.mode&0o777)!==0o600)throw Error();
        fd=openSync(path,constants.O_RDONLY|(constants.O_NOFOLLOW??0));const opened=fstatSync(fd);
        if(!opened.isFile()||opened.nlink!==1||opened.dev!==before.dev||opened.ino!==before.ino||opened.size!==before.size||
            process.platform!=='win32'&&(opened.mode&0o777)!==0o600)throw Error();
        bytes=Buffer.alloc(opened.size+1);let offset=0;
        while(offset<bytes.length){const length=readSync(fd,bytes,offset,bytes.length-offset,null);if(!length)break;offset+=length;}
        const after=fstatSync(fd),named=lstatSync(path);
        if(offset!==opened.size||after.size!==opened.size||after.mtimeMs!==opened.mtimeMs||after.ctimeMs!==opened.ctimeMs||
            after.nlink!==1||named.isSymbolicLink()||named.dev!==after.dev||named.ino!==after.ino||!samePath(realpathSync(path),path))throw Error();
        const value=bytes.subarray(0,offset).toString('utf8');
        if(!/^[a-f0-9]{64}(?:\r?\n)?$/i.test(value))throw Error();
        return Buffer.from(value.slice(0,64),'hex');
    } catch {throw Error('Atestación propietario: archivo privado no disponible');}
    finally {bytes?.fill(0);if(fd!==undefined)closeSync(fd);}
}
export function signProductionNotesOwner(body: unknown, purpose: 'admission' | 'issued' | 'status', explicit?: Buffer): ProductionNotesOwnerProof {
    const issuedAt = new Date().toISOString(), bodySha256 = fiscalSnapshotSha256(body), secret = key(explicit);
    try {
        return { issuedAt, bodySha256, signature: createHmac('sha256', secret).update('factuez:production-notes:' + purpose + ':' + issuedAt + ':' + bodySha256).digest('hex') };
    }
    finally {
        secret.fill(0);
    }
}
export function assertProductionNotesOwner(body: unknown, purpose: 'admission' | 'issued' | 'status', proof: ProductionNotesOwnerProof, explicit?: Buffer) {
    if (!proof || Object.keys(proof).sort().join(',') !== 'bodySha256,issuedAt,signature' || !Number.isFinite(Date.parse(proof.issuedAt)) || !/^[a-f0-9]{64}$/.test(proof.signature) || proof.bodySha256 !== fiscalSnapshotSha256(body) ||
        Date.parse(proof.issuedAt) > Date.now() + 30000 || purpose === 'admission' && Date.now() - Date.parse(proof.issuedAt) > 30000)
        throw Error('Atestación propietario inválida/expirada');
    const secret = key(explicit);
    try {
        const expected = createHmac('sha256', secret).update('factuez:production-notes:' + purpose + ':' + proof.issuedAt + ':' + proof.bodySha256).digest();
        if (!timingSafeEqual(expected, Buffer.from(proof.signature, 'hex')))
            throw Error('Atestación propietario no auténtica');
    }
    finally {
        secret.fill(0);
    }
}
