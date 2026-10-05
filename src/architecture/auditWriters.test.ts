import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

// The audit trail has one writer. These guards fail when a controller or service starts writing an
// audit table on its own again, which is how the four separate audit tables drifted apart before.
const srcDir = path.resolve(__dirname, '..');

function sourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts') ? [full] : [];
  });
}

const files = sourceFiles(srcDir).map((file) => ({ rel: path.relative(srcDir, file).replace(/\\/g, '/'), text: fs.readFileSync(file, 'utf8') }));
const withoutComments = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

describe('audit writers', () => {
  it('scans the source tree it is meant to guard', () => {
    expect(files.length).toBeGreaterThan(100);
    expect(files.some((file) => file.rel === 'middleware/platform.ts')).toBe(true);
  });

  it('only middleware/platform.ts writes PlatformAuditLog', () => {
    const offenders = files
      .filter((file) => file.rel !== 'middleware/platform.ts' && /platformAuditLog\s*\.\s*(create|createMany|update|updateMany|upsert|delete|deleteMany)\b/.test(withoutComments(file.text)))
      .map((file) => file.rel);
    expect(offenders).toEqual([]);
  });

  it('nothing writes the legacy audit tables any more', () => {
    const offenders = files
      .filter((file) => /\b(auditLog|accessAuditLog|procurementAuditEvent)\s*\.\s*(create|createMany|update|updateMany|upsert|delete|deleteMany)\b/.test(withoutComments(file.text)))
      .map((file) => file.rel);
    expect(offenders).toEqual([]);
  });

  it('files that record an audit event inside a transaction actually open one', () => {
    // platform.ts defines recordAuditEvent and utils/erp.ts is the thin audit(tx, ...) wrapper that
    // passes its caller's transaction through; neither opens a transaction itself.
    const helpers = new Set(['middleware/platform.ts', 'utils/erp.ts']);
    const offenders = files
      .filter((file) => !helpers.has(file.rel) &&/\brecordAuditEvent\(|\baudit\(tx\b/.test(withoutComments(file.text)))
      .filter((file) => !/\$transaction\(/.test(file.text))
      .map((file) => file.rel);
    expect(offenders).toEqual([]);
  });
});
