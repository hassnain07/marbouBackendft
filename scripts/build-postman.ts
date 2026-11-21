import { execSync } from 'child_process';
import path from 'path';

const root = path.resolve(__dirname, '..');
execSync(`python ${path.join(root, 'scripts', 'gen_postman.py')}`, {
  stdio: 'inherit',
  cwd: root,
});
