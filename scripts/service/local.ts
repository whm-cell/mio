import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import {
  createLocalEnvironment,
  localHostEnvironment,
  readLocalEnvironment,
} from './local-environment.ts';
import { prepareProfile } from './profile.ts';
import { localWorkerEnvironment } from './local-compute-environment.ts';

const [name, action, ...args] = process.argv.slice(2);

async function run(binary: string, argv: string[], env: NodeJS.ProcessEnv): Promise<void> {
  const child = spawn(binary, argv, { env, stdio: 'inherit' });
  let cancelled = false;
  const interrupt = () => {
    cancelled = true;
    child.kill('SIGINT');
  };
  const terminate = () => {
    cancelled = true;
    child.kill('SIGTERM');
  };
  process.once('SIGINT', interrupt);
  process.once('SIGTERM', terminate);
  try {
    await new Promise<void>((ok, fail) => {
      child.once('error', fail);
      child.once('exit', (code, signal) => {
        if (code === 0 && !cancelled) ok();
        else fail(new Error(`LOCAL_COMMAND_FAILED: ${binary} exited ${code ?? signal}`));
      });
    });
  } finally {
    process.off('SIGINT', interrupt);
    process.off('SIGTERM', terminate);
  }
}

async function checkLocal(name: 'dev' | 'test' | 'auto') {
  if (!args.length) throw new Error('LOCAL_CHECK_SCOPE: provide a test file or directory');
  if (name !== 'auto') {
    try {
      await readLocalEnvironment(name);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  await run('pnpm', ['test', ...args], {
    ...localHostEnvironment(),
    MIO_TEST_LOCAL_ENVIRONMENT: name,
    ...(process.env.MIO_TEST_REDIS_SERVER
      ? { MIO_TEST_REDIS_SERVER: process.env.MIO_TEST_REDIS_SERVER }
      : {}),
  });
}

async function main(name: 'dev' | 'test') {
  if (action === 'init' && args.length === 0) {
    console.log(`${name}: private configuration ${await createLocalEnvironment(name)}`);
    return;
  }
  const environment = await readLocalEnvironment(name);
  const { runtime, values, host, file } = environment;
  if (action === 'regression-init' && args.length === 0) {
    const { prepareLocalRegression } = await import('./local-regression.ts');
    await prepareLocalRegression(name, values);
    return;
  }
  if (
    action === 'broker-init' &&
    (args.length === 0 || (args.length === 1 && args[0] === '--migrate-video-probe'))
  ) {
    const { prepareLocalBroker } = await import('./local-broker.ts');
    await prepareLocalBroker(name, values, args.length === 1);
    return;
  }
  if (action === 'monitor-init' && args.length === 0) {
    const { prepareAdminMonitors } = await import('./init-admin-monitors.ts');
    await prepareAdminMonitors(name);
    return;
  }
  if (action === 'compute' && args.length === 1 && ['init', 'start'].includes(args[0]!)) {
    const worker = localWorkerEnvironment(name, values, host);
    if (args[0] === 'start') {
      for (const key of [
        'MIO_COS_BUCKET',
        'MIO_COS_REGION',
        'MIO_COS_SECRET_ID',
        'MIO_COS_SECRET_KEY',
      ])
        if (!worker[key])
          throw new Error(`LOCAL_WORKER_CONFIG: set ${key} in the selected environment file`);
    }
    console.log(`${name}: Worker ${args[0]} (${values.MIO_LOCAL_COMPUTE_DIRECTORY})`);
    await run(process.execPath, ['compute/dist/main.js', args[0]!], worker);
    return;
  }
  if (action === 'infra' && args.length === 1 && ['up', 'stop', 'status'].includes(args[0]!)) {
    const operation =
      args[0] === 'up'
        ? ['up', '-d', '--wait', '--wait-timeout', '120']
        : args[0] === 'status'
          ? ['ps']
          : ['stop'];
    await run(
      'docker',
      [
        'compose',
        '--env-file',
        file,
        '-p',
        `mio-${name}`,
        '-f',
        'deploy/local/compose.yaml',
        ...operation,
      ],
      host,
    );
    return;
  }
  if (action === 'start' && args.length === 0) {
    await prepareProfile(runtime.DSH_HOME, resolve('.'));
    console.log(`Starting ${name} at ${values.MIO_AUTH_BASE_URL}`);
    await run(process.execPath, ['scripts/service/start.ts'], runtime);
    return;
  }
  if (action === 'generations-preflight') {
    await run(process.execPath, ['scripts/service/generation-cutover.ts', ...args], {
      ...values,
      ...runtime,
    });
    return;
  }
  if (action === 'migrate') {
    const domain = args[0] && !args[0].startsWith('--') ? args.shift()! : 'auth';
    if (
      ![
        'auth',
        'conversations',
        'providers',
        'assets',
        'compute',
        'generations',
        'materials',
        'admin',
      ].includes(domain) ||
      args.some(
        (arg) => !['--apply', '--with-conversations', '--rollback-sms-budget'].includes(arg),
      ) ||
      (domain !== 'providers' && args.includes('--with-conversations')) ||
      (domain !== 'auth' && args.includes('--rollback-sms-budget'))
    )
      throw new Error(
        'Usage: local <dev|test> migrate [auth|conversations|providers|assets|compute|generations|materials|admin] [--apply] [--rollback-sms-budget for auth]',
      );
    console.log(`${name}: ${domain} migration ${args.includes('--apply') ? 'apply' : 'preview'}`);
    await run(process.execPath, [`scripts/service/migrate-${domain}.ts`, ...args], runtime);
    return;
  }
  if (
    action === 'route' &&
    args.length === 1 &&
    (args[0] === '--stdin' || !args[0]!.startsWith('--'))
  ) {
    await run(process.execPath, ['scripts/service/import-provider-route.ts', args[0]!], runtime);
    return;
  }
  if (action === 'admin-bootstrap' && args.length >= 2) {
    await run(process.execPath, ['scripts/service/bootstrap-admin.ts', ...args], runtime);
    return;
  }
  throw new Error(
    'LOCAL_ACTION: expected init, infra up|stop|status, regression-init, broker-init, monitor-init, compute init|start, generations-preflight, start, migrate, route, admin-bootstrap or check',
  );
}

if (action === 'check' && (name === 'dev' || name === 'test' || name === 'auto')) {
  await checkLocal(name);
} else if (name === 'dev' || name === 'test') {
  await main(name);
} else {
  throw new Error('Usage: local <dev|test> <action>');
}
