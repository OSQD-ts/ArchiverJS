import { writeFileSync } from 'node:fs';

// Node resolves `type` from the nearest package.json. The root manifest declares
// "type": "module", so the CommonJS output needs its own marker to be loadable
// via require() from a CJS consumer.
writeFileSync('dist/cjs/package.json', JSON.stringify({ type: 'commonjs' }, null, 2) + '\n');
writeFileSync('dist/esm/package.json', JSON.stringify({ type: 'module' }, null, 2) + '\n');
