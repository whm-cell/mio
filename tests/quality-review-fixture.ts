/** Synthetic observations for testing the evidence protocol, never a real source-review verdict. */
export function reviewFixture(candidate: string) {
  return {
    candidate,
    reviewer: 'isolated fixture reviewer',
    scope: ['src/value.ts'],
    dimensions: {
      algorithm: { result: 'pass', evidence: 'Fixture value lookup has constant cost.' },
      unused: { result: 'pass', evidence: 'Fixture consumer uses the exported value.' },
      reuse: { result: 'not_applicable', evidence: 'Fixture has no competing implementation.' },
    },
    limitations: 'Synthetic fixture; verifies bookkeeping, not semantic review quality.',
  };
}

export const reviewMarkdown = (report: unknown) =>
  `# Quality review\n\n\`\`\`mio-quality-review\n${JSON.stringify(report, null, 2)}\n\`\`\`\n`;
