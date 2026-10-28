import { createHmac, timingSafeEqual } from 'node:crypto';
import { fiscalCanonical, fiscalSnapshotSha256 } from './fiscal-note';
import type { ProductionBatchesProof } from '@factuez/contracts/production-batches';
/** Separate keys for owner commands and SUNAT outcomes. Keys are injected by composition, never read here. */
export class ProductionBatchesAuthenticator {
  constructor(private readonly key: Buffer | (() => Buffer), private readonly audience: 'billing-owner' | 'sunat-status') {
    if (typeof key !== 'function' && (!Buffer.isBuffer(key) || key.length < 32)) throw Error('Clave HMAC de lotes requerida');
    if (Buffer.isBuffer(key)) this.key = Buffer.from(key);
  }
  sign(body: unknown): ProductionBatchesProof {
    const key = typeof this.key === 'function' ? this.key() : this.key;
    if (!Buffer.isBuffer(key) || key.length < 32) throw Error('Clave HMAC de lotes requerida');
    return { bodySha256:fiscalSnapshotSha256(body),signature:createHmac('sha256',key).update('production-batches/v1/' + this.audience + '\n' + fiscalCanonical(body)).digest('hex') };
  }
  verify(body: unknown, proof: ProductionBatchesProof) {
    const expected = this.sign(body);
    if (!proof || Object.keys(proof).sort().join(',') !== 'bodySha256,signature' || proof.bodySha256 !== expected.bodySha256 || !/^[a-f0-9]{64}$/.test(proof.signature) ||
        !timingSafeEqual(Buffer.from(proof.signature,'hex'),Buffer.from(expected.signature,'hex'))) throw Error('Prueba HMAC de propietario inválida');
  }
}
