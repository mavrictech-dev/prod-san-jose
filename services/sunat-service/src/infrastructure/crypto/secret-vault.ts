import { Inject, Injectable, Optional, ServiceUnavailableException } from "@nestjs/common";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { inspect } from "node:util";

export type SecretContext = { ruc: string; environment: string; field: string };

/** AES-GCM liga cada secreto al RUC, ambiente y campo; la clave nunca va a BD. */
export const SUNAT_VAULT_KEY=Symbol('Explicit SUNAT vault key');
@Injectable()
export class SecretVault {
  private destroyed=false;
  constructor(@Optional() @Inject(SUNAT_VAULT_KEY) key?:Buffer){
    if(key!==undefined){if(!Buffer.isBuffer(key)||key.length!==32)throw new ServiceUnavailableException('SUNAT_VAULT_KEY_REQUIRED');this.#key=Buffer.from(key);}
  }
  onModuleDestroy(){this.destroyed=true;this.#key?.fill(0);this.#key=undefined;}
  #key?: Buffer;
  private masterKey() {
    if(this.destroyed)throw new ServiceUnavailableException('SUNAT_VAULT_CLOSED');
    if (this.#key) return this.#key;
    try {
      const path = process.env.APP_MASTER_KEY_FILE;
      if (!path) throw new Error();
      const value = readFileSync(path, "utf8").trim();
      const key = /^[a-f0-9]{64}$/i.test(value)
        ? Buffer.from(value, "hex")
        : /^[A-Za-z0-9_+/=-]{43,44}$/.test(value)
          ? Buffer.from(value, "base64url") : Buffer.alloc(0);
      if (key.length !== 32) throw new Error();
      return (this.#key = key);
    } catch {
      throw new ServiceUnavailableException("La bóveda de secretos no está disponible");
    }
  }
  private aad(context: SecretContext) {
    return Buffer.from(JSON.stringify(["factuez-secrets", 1, context.ruc, context.environment, context.field]));
  }
  seal(value: string | Buffer, context: SecretContext): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.masterKey(), iv);
    cipher.setAAD(this.aad(context));
    const encrypted = Buffer.concat([cipher.update(value), cipher.final()]);
    return ["v1", iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), encrypted.toString("base64url")].join(".");
  }
  open(envelope: string, context: SecretContext): Buffer {
    const key = this.masterKey();
    try {
      const [version, nonce, tag, data, ...extra] = envelope.split(".");
      if (version !== "v1" || extra.length || !nonce || !tag || !data) throw new Error();
      const iv = Buffer.from(nonce, "base64url");
      const authTag = Buffer.from(tag, "base64url");
      if (iv.length !== 12 || authTag.length !== 16) throw new Error();
      const decipher = createDecipheriv("aes-256-gcm", key, iv);
      decipher.setAAD(this.aad(context));
      decipher.setAuthTag(authTag);
      return Buffer.concat([decipher.update(Buffer.from(data, "base64url")), decipher.final()]);
    } catch {
      throw new ServiceUnavailableException("No se pudo verificar el secreto almacenado");
    }
  }
  toJSON(){return {service:'SecretVault',contents:'PRIVATE',closed:this.destroyed};}
  [inspect.custom](){return this.toJSON();}
}
