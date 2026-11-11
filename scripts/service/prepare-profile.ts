import { resolve } from 'node:path';
import { localHome, prepareProfile } from './profile.ts';

const args = process.argv.slice(2);
if (args.length !== 0 && (args.length !== 2 || args.some((value) => value.length === 0)))
  throw new Error('Usage: prepare-profile [<dsh-home> <plugin-directory>]');
await prepareProfile(
  args[0] ? resolve(args[0]) : localHome(),
  args[1] ? resolve(args[1]) : resolve('.'),
);
console.log(
  args.length
    ? 'Prepared isolated mio profile for the specified plugin.'
    : 'Prepared isolated local mio profile. Configure MIO_API_TOKEN, then run pnpm start.',
);
