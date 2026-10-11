import { randomBytes } from 'node:crypto';
// Run ONCE locally. Copy the result to Secret Manager and retain a private backup.
// Do not put this value in any frontend file or commit it.
process.stdout.write(randomBytes(32).toString('base64') + '\n');
