/** SOL UI accepts a secondary user or an already RUC-prefixed user. Never echo credentials. */
export function productionGuidesSolUsername(ruc: string, raw: unknown): string {
 if (!/^(10|20)\d{9}$/.test(ruc) || typeof raw !== 'string' || !/^[A-Za-z0-9]{1,41}$/.test(raw)) throw Error('GRE_CREDENTIALS_INVALID');
 const prefix = /^(\d{11})/.exec(raw);
 if (prefix && prefix[1] !== ruc) throw Error('GRE_CREDENTIALS_INVALID');
 const user = prefix ? raw.slice(11) : raw;
 if (!/^[A-Za-z0-9]{1,30}$/.test(user) || /^\d{11}/.test(user)) throw Error('GRE_CREDENTIALS_INVALID');
 return ruc + user;
}
