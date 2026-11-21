/**
 * Generates openapi.json by importing all routers (which fills the registry)
 * then writing the spec to disk.
 * Run: npm run openapi
 */
import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';
dotenv.config();

// Import routers to populate the registry
import '../src/modules/auth/routes';
import '../src/modules/users/routes';
import '../src/modules/admin/routes';
import '../src/modules/catalog/routes';

import { generateOpenApiSpec } from '../src/shared/openapi';

const spec = generateOpenApiSpec();
const outPath = path.resolve(__dirname, '../openapi.json');
fs.writeFileSync(outPath, JSON.stringify(spec, null, 2));
console.log(`✅ openapi.json written to ${outPath}`);
