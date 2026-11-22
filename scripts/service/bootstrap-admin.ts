import { hashAdminPassword } from '../../src/auth/admin-password.ts';
import { readProviderConfig } from '../../src/providers/config.ts';
import { createAdminStore } from '../../src/admin/store.ts';

const USERNAME_PATTERN = /^[A-Za-z0-9_.-]{3,64}$/;

async function readPasswordFromStdin(): Promise<string> {
  if (process.stdin.isTTY) throw new Error('ADMIN_BOOTSTRAP: pipe password via stdin');
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buf.byteLength;
    if (size > 512) throw new Error('ADMIN_BOOTSTRAP: password input too large');
    chunks.push(buf);
  }
  return Buffer.concat(chunks)
    .toString('utf8')
    .replace(/\r?\n$/, '');
}

const args = process.argv.slice(2);
let username: string | undefined;
let useStdin = false;
let resetPassword = false;

for (let i = 0; i < args.length; i += 1) {
  const arg = args[i];
  if (arg === '--username' && args[i + 1]) {
    username = args[i + 1];
    i += 1;
  } else if (arg === '--password-stdin') {
    useStdin = true;
  } else if (arg === '--reset-password') {
    resetPassword = true;
  } else {
    console.error(
      'Usage: admin:bootstrap --username <username> --password-stdin [--reset-password]',
    );
    process.exit(1);
  }
}

if (!username || !USERNAME_PATTERN.test(username) || !useStdin) {
  console.error('Usage: admin:bootstrap --username <username> --password-stdin [--reset-password]');
  process.exit(1);
}

const password = await readPasswordFromStdin();
if (password.length < 8 || password.length > 128) {
  console.error('ADMIN_BOOTSTRAP: password must be 8..128 characters');
  process.exit(1);
}

const providerConfig = readProviderConfig();
if (!providerConfig) throw new Error('ADMIN_CONFIG: provider configuration required');

const store = await createAdminStore({
  databaseURL: providerConfig.databaseURL,
  allowedOrigins: [],
});
try {
  const passwordHash = await hashAdminPassword(password);
  const result = await store.bootstrapSuperAdmin(username, passwordHash, resetPassword);
  console.log(
    JSON.stringify({
      created: result.created,
      resetPassword,
      admin: result.admin,
    }),
  );
} finally {
  await store.close();
}
