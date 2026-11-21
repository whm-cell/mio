import { getSystemErrorName } from 'node:util';

export type ExchangeFiles = (first: string, second: string) => void;

/** An exchange preserves both path occupants in a single filesystem operation. */
export async function loadPublicationExchange(): Promise<ExchangeFiles> {
  const platform = process.platform;
  if (platform !== 'darwin' && platform !== 'linux')
    throw new Error(`WORK_PUBLISH_ATOMIC: file exchange is unavailable on ${platform}`);
  try {
    const { default: koffi } = await import('koffi');
    const libc = koffi.load(null);
    let exchange: (first: string, second: string) => number;
    if (platform === 'darwin') {
      const rename = libc.func('int renamex_np(str first, str second, uint flags)');
      const renameSwap = 2;
      exchange = (first, second) => rename(first, second, renameSwap);
    } else {
      const rename = libc.func(
        'int renameat2(int firstDir, str first, int secondDir, str second, uint flags)',
      );
      const currentDirectory = -100;
      const renameExchange = 2;
      exchange = (first, second) =>
        rename(currentDirectory, first, currentDirectory, second, renameExchange);
    }
    return (first, second) => {
      if (exchange(first, second) === 0) return;
      const errno = koffi.errno();
      const reason = errno > 0 ? getSystemErrorName(-errno) : 'unknown system error';
      throw new Error(`WORK_PUBLISH_ATOMIC: file exchange failed (${reason})`);
    };
  } catch (cause) {
    throw new Error('WORK_PUBLISH_ATOMIC: cannot load native file exchange', { cause });
  }
}
