import { copyFile, mkdir } from 'node:fs/promises';
import { swaggerFiles } from '../src/documentation.js';

const source = new URL('../node_modules/swagger-ui-dist/', import.meta.url);
const destination = new URL('../.wrangler/doc-assets/doc/assets/', import.meta.url);
await mkdir(destination, { recursive: true });
await Promise.all(swaggerFiles.map(file => copyFile(new URL(file, source), new URL(file, destination))));
