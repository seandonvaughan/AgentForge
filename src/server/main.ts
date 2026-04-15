import { launchPackageCanonicalServer } from './index.js';

async function main() {
  await launchPackageCanonicalServer();
}

main().catch(err => {
  console.error('Server startup failed:', err);
  process.exit(1);
});
