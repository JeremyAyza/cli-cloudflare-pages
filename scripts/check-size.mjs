import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const MAX_UNPACKED_SIZE = 3_000_000;
const ALLOWED_FILE_PREFIXES = ['dist/', 'skills/', 'README.md', 'LICENSE', 'CHANGELOG.md', 'package.json'];

const pkg = JSON.parse(readFileSync('package.json', 'utf8'));

if (pkg.dependencies && Object.keys(pkg.dependencies).length > 0) {
  console.error('Error: package.json must not have runtime dependencies. Runtime dependencies must be bundled.');
  process.exit(1);
}

const raw = execSync('npm pack --dry-run --json', { encoding: 'utf8' });
const [packInfo] = JSON.parse(raw);

if (!packInfo) {
  console.error('Error: Could not parse npm pack output.');
  process.exit(1);
}

if (packInfo.unpackedSize >= MAX_UNPACKED_SIZE) {
  console.error(`Error: Unpacked size ${packInfo.unpackedSize} exceeds maximum ${MAX_UNPACKED_SIZE} bytes.`);
  process.exit(1);
}

for (const file of packInfo.files) {
  const allowed = ALLOWED_FILE_PREFIXES.some((p) => file.path === p || file.path.startsWith(p));
  if (!allowed) {
    console.error(`Error: Unexpected file in tarball: ${file.path}`);
    process.exit(1);
  }
}

console.log(
  `Package size OK: ${(packInfo.unpackedSize / 1024).toFixed(1)} kB unpacked (${packInfo.files.length} files).`,
);
