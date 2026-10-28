import { BadRequestException, Injectable } from '@nestjs/common';
import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCallback);
const KEY_LENGTH = 64;

/** Hashes de contraseña locales. Nunca se almacenan ni registran contraseñas en claro. */
@Injectable()
export class PasswordService {
  async hash(password: string): Promise<string> {
    this.validate(password);
    const salt = randomBytes(16);
    const derivedKey = (await scrypt(password, salt, KEY_LENGTH)) as Buffer;
    return `scrypt$${salt.toString('base64url')}$${derivedKey.toString('base64url')}`;
  }

  async verify(password: string, storedHash: string): Promise<boolean> {
    const [algorithm, encodedSalt, encodedKey] = storedHash.split('$');
    if (algorithm !== 'scrypt' || !encodedSalt || !encodedKey) return false;

    const expected = Buffer.from(encodedKey, 'base64url');
    const actual = (await scrypt(password, Buffer.from(encodedSalt, 'base64url'), expected.length)) as Buffer;
    return expected.length === actual.length && timingSafeEqual(expected, actual);
  }

  private validate(password: string) {
    if (typeof password !== 'string' || password.length < 12 || password.length > 256) {
      throw new BadRequestException('La contraseña debe tener entre 12 y 256 caracteres');
    }
  }
}
