import { resolve } from 'node:path';
import { localHome, prepareProfile } from './profile.ts';

await prepareProfile(localHome(), resolve('.'));
console.log('Prepared isolated local mio profile. Configure MIO_API_TOKEN, then run pnpm start.');
