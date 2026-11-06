import {scryptSync} from 'node:crypto';
import {writeFileSync} from 'node:fs';
const salt = 'a104b71525368799b1b01232c73f1f04';
const passwords = ['Alcor12345', '中文Alcor9', 'Astral🛰️9', 'éAlcor123', 'éAlcor123'];
const cases = passwords.map(password => ({password, stored: `${salt}:${scryptSync(password,salt,64).toString('hex')}`}));
writeFileSync(new URL('../contracts/password-vectors.json', import.meta.url),JSON.stringify({source:'Node crypto.scryptSync default parameters; synthetic inputs only',cases},null,2)+'\n');
