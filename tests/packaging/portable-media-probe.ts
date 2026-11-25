import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { portableComponent, portableRoot } from './portable-root.ts';

const worker = portableComponent(portableRoot(process.argv[2]), 'b');
const scratch = await mkdtemp(join(tmpdir(), 'mio portable media-'));

const verify = String.raw`
  import assert from 'node:assert/strict';
  import { spawnSync } from 'node:child_process';
  import { randomUUID } from 'node:crypto';
  import { copyFileSync, statSync } from 'node:fs';
  import { MEDIA_PROFILE, MEDIA_VERSION, parseMediaCommand } from '@mio/compute-contracts';
  import { Journal } from './dist/adapters/journal.js';
  import { MediaFiles } from './dist/adapters/media-files.js';
  import { bundledFontsDirectory, checkBundledFonts } from './dist/adapters/fonts.js';
  import { checkMediaCapabilities, managedProcess, MediaProcessAdapter } from './dist/adapters/media-process.js';
  import { executeMedia } from './dist/media-executor.js';
  import { probeFile } from './dist/plans/probe.js';

  const scratch = process.argv[1];
  const signal = AbortSignal.timeout(60_000);
  await checkMediaCapabilities(signal);
  const fonts = await checkBundledFonts();
  assert.equal(fonts.sans.family, 'Noto Sans CJK SC');
  assert.equal(fonts.serif.family, 'Noto Serif CJK SC');
  assert.equal(fonts.sans.width('中文', 48), 96);
  assert.equal(fonts.serif.width('中文', 48), 96);
  console.log('PORTABLE_MEDIA_CAPABILITIES_OK');

  const journal = new Journal(scratch, 'portable-m4', true);
  function media(operation, parameters, sourcePath) {
    const assetId = randomUUID();
    const command = parseMediaCommand({
      version: MEDIA_VERSION,
      type: 'media.request',
      messageId: randomUUID(),
      jobId: randomUUID(),
      attemptId: randomUUID(),
      attempt: 1,
      profile: MEDIA_PROFILE,
      operation,
      parameters,
      inputs: [{
        assetId,
        key: 'mio/raw/' + assetId + '/' + randomUUID(),
        sizeBytes: sourcePath ? statSync(sourcePath).size : 1,
        etag: 'local-portable-fixture',
      }],
    });
    const files = new MediaFiles(scratch, command.attemptId);
    const attempt = journal.media.accept(command);
    const adapter = new MediaProcessAdapter(files, journal.media, attempt, signal, () => {});
    const diagnostics = [];
    const context = {
      async run(step, discover) {
        const rendersAss = step.args.some((arg) => arg.includes('fontsdir=@font:bundled'));
        const observed = rendersAss
          ? { ...step, args: step.args.map((arg, index) => step.args[index - 1] === '-v' ? 'verbose' : arg) }
          : step;
        const result = await adapter.run(observed, discover);
        if (rendersAss) diagnostics.push(result.diagnostic);
        return result;
      },
      write: (name, value) => files.write(name, value),
      read: (name, maxBytes) => files.read(name, maxBytes),
    };
    return { command, files, context, diagnostics };
  }

  function checkGlyphSource(task, family, fileName) {
    const diagnostics = task.diagnostics.join('\n');
    const fontPath = bundledFontsDirectory() + fileName + '.otf';
    assert(diagnostics.split('\n').some((line) => line.includes('Loading font file') && line.includes(fontPath)), diagnostics);
    assert(diagnostics.split('\n').some((line) =>
      line.includes('fontselect: (' + family + ',') && line.includes(fileName)
    ), diagnostics);
    console.log('PORTABLE_MEDIA_FONT_OK', family, fontPath);
  }

  function rgb(file, seconds) {
    const result = spawnSync('ffmpeg', [
      '-v', 'error', '-nostdin', '-threads', '2', '-ss', seconds, '-i', file, '-frames:v', '1',
      '-vf', 'format=rgb24,crop=288:128:176:116',
      '-c:v', 'rawvideo', '-threads', '2', '-f', 'rawvideo', '-',
    ], { timeout: 10_000, maxBuffer: 160 * 1024 });
    assert.equal(result.status, 0, String(result.stderr));
    return result.stdout;
  }

  try {
    const task = media('subtitle.burn', {
      cues: [
        { startSeconds: 0.1, endSeconds: 0.4, text: '中国' },
        { startSeconds: 0.4, endSeconds: 0.7, text: '山水' },
      ],
      style: { font: 'serif', fontSize: 220, color: '#ffffff', background: '#00ff00',
        outlineColor: '#0000ff', outline: 12, alignment: 'middle' },
    });
    const source = await managedProcess('ffmpeg', [
      '-v', 'error', '-f', 'lavfi', '-i', 'color=c=red:s=640x360:r=25:d=0.8',
      '-f', 'lavfi', '-i', 'sine=frequency=440:duration=0.8', '-c:v', 'libx264',
      '-c:a', 'aac', '-f', 'mp4', 'input-0',
    ], signal, undefined, { cwd: task.files.directory });
    assert.equal(source.exitCode, 0, source.diagnostic);
    const result = await executeMedia(task.command, task.context);
    const primary = result.files[0].name;
    const rendered = await probeFile(primary, 'portable-check-render', task.context);
    assert.equal(rendered.videoCodec, 'h264');
    assert.equal(rendered.audioCodec, 'aac');

    const file = task.files.path(primary);
    const first = rgb(file, '0.2');
    const next = rgb(file, '0.5');
    const blank = rgb(file, '0.75');
    assert.equal(first.length, 288 * 128 * 3);
    assert.deepEqual(next.length, first.length);
    assert.equal(first.equals(next), false);
    assert.equal(first.equals(blank), false);
    let text = 0, outline = 0, background = 0;
    for (let i = 0; i < first.length; i += 3) {
      const [r, g, b] = [first[i], first[i + 1], first[i + 2]];
      if (r > 195 && g > 195 && b > 195) text++;
      if (r < 90 && g < 100 && b > 135) outline++;
      if (r < 100 && g > 135 && b < 100) background++;
    }
    assert(text > 70 && outline > 40 && background > 150);
    checkGlyphSource(task, 'Noto Serif CJK SC', 'NotoSerifCJKsc-Regular');
    console.log('PORTABLE_MEDIA_CJK_OK');

    const timeline = media('composition.render', {
      resolution: '720p', durationSeconds: 0.6,
      tracks: [{ kind: 'video', index: 0 }, { kind: 'subtitle', index: 0 }],
      items: [
        { kind: 'video', track: 0, inputIndex: 0, startSeconds: 0, durationSeconds: 0.4 },
        { kind: 'subtitle', track: 0, startSeconds: 0, durationSeconds: 0.3, text: '中文', style: { font: 'sans' } },
      ],
    }, file);
    copyFileSync(file, timeline.files.path('input-0'));
    await executeMedia(timeline.command, timeline.context);
    checkGlyphSource(timeline, 'Noto Sans CJK SC', 'NotoSansCJKsc-Regular');
    console.log('PORTABLE_MEDIA_COMPOSITION_OK');

    for (const [format, codec] of [['webm', 'vp9'], ['mp3', 'mp3']]) {
      const task = media('media.export', { format }, file);
      copyFileSync(file, task.files.path('input-0'));
      const result = await executeMedia(task.command, task.context);
      const probe = await probeFile(result.files[0].name, 'portable-check-export', task.context);
      assert.equal(format === 'webm' ? probe.videoCodec : probe.audioCodec, codec);
      assert(probe.durationSeconds > 0.7);
    }
    console.log('PORTABLE_MEDIA_CODECS_OK');
  } finally {
    journal.close();
  }
`;

try {
  const fontConfig = join(scratch, 'fonts.conf');
  // In the portable process, fontconfig starts with an empty system font set.
  // libass receives the trusted bundled directory from the built Worker adapter.
  await writeFile(fontConfig, '<?xml version="1.0"?><fontconfig></fontconfig>\n');
  const checked = spawnSync(process.execPath, ['--input-type=module', '-e', verify, scratch], {
    cwd: worker,
    env: {
      PATH: process.env.PATH ?? '/usr/bin:/bin',
      LANG: 'C.UTF-8',
      HOME: scratch,
      FONTCONFIG_FILE: fontConfig,
      FONTCONFIG_PATH: scratch,
      TMPDIR: scratch,
    },
    encoding: 'utf8',
    timeout: 70_000,
  });
  if (checked.stdout) process.stdout.write(checked.stdout);
  if (checked.stderr) process.stderr.write(checked.stderr);
  if (checked.error) throw checked.error;
  if (checked.status !== 0) throw new Error('PORTABLE_MEDIA_CHECK_FAILED');
} finally {
  await rm(scratch, { recursive: true, force: true });
}
