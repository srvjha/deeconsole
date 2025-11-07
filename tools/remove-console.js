#!/usr/bin/env node

import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const distEntry = path.resolve(__dirname, '../dist/index.js');

async function main() {
  try {
    await import(pathToFileURL(distEntry).href);
  } catch (error) {
    console.error('[deeconsole] Failed to load compiled CLI from dist/index.js');
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}

void main();