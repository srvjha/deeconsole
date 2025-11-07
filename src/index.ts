#!/usr/bin/env node

import { Command } from 'commander';
import fg from 'fast-glob';
import { readFile, writeFile, stat, access, constants as fsConstants } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse, type ParserPlugin } from '@babel/parser';
import * as traverseModule from '@babel/traverse';
import type { NodePath, TraverseOptions } from '@babel/traverse';
import * as t from '@babel/types';
import MagicString from 'magic-string';

type CallLikePath = NodePath<t.CallExpression> | NodePath<t.OptionalCallExpression>;

type TraverseFn = (
  parent: t.Node,
  opts?: TraverseOptions,
  scope?: unknown,
  state?: unknown,
  parentPath?: NodePath<t.Node>
) => void;

const traverse: TraverseFn = resolveTraverse(traverseModule);
function resolveTraverse(module: typeof traverseModule): TraverseFn {
  const maybeDefault = (module as unknown as { default?: unknown }).default;

  if (typeof maybeDefault === 'function') {
    return maybeDefault as TraverseFn;
  }

  if (maybeDefault && typeof (maybeDefault as { default?: unknown }).default === 'function') {
    return (maybeDefault as { default: TraverseFn }).default;
  }

  if (typeof (module as unknown) === 'function') {
    return module as unknown as TraverseFn;
  }

  throw new TypeError('Unable to resolve @babel/traverse default export.');
}

interface CliOptions {
  comment: boolean;
  backup: boolean;
  dryRun: boolean;
  pattern: string[];
  ignore: string[];
  cwd: string;
  verbose: boolean;
}

interface NormalizedOptions extends CliOptions {
  cwd: string;
}

interface FileResult {
  file: string;
  statements: number;
  changed: boolean;
  skipped: number;
}

const DEFAULT_PATTERNS = ['**/*.{js,jsx,ts,tsx,cjs,mjs,cts,mts}'];
const DEFAULT_IGNORES = [
  '**/node_modules/**',
  '**/dist/**',
  '**/build/**',
  '**/.git/**',
  '**/.next/**',
  '**/coverage/**'
];

const parserPlugins: ParserPlugin[] = [
  'jsx',
  'typescript',
  'classProperties',
  'classPrivateProperties',
  'classPrivateMethods',
  'decorators-legacy',
  'dynamicImport',
  'objectRestSpread',
  'optionalChaining',
  'nullishCoalescingOperator',
  'topLevelAwait'
];

const program = new Command();

async function main(): Promise<void> {
  const version = await getPackageVersion();

  program
    .name('deconsole')
    .description('Remove or comment console statements throughout your project files.')
    .version(version)
    .option('-c, --comment', 'Comment out console statements instead of deleting them', false)
    .option('-b, --backup', 'Create a .bak file before overwriting each changed file', false)
    .option('--dry-run', 'Preview files and statements without writing changes', false)
    .option('-p, --pattern <glob...>', 'Glob pattern(s) of files to process', DEFAULT_PATTERNS)
    .option('-i, --ignore <glob...>', 'Glob pattern(s) to ignore', DEFAULT_IGNORES)
    .option('--cwd <dir>', 'Working directory for glob resolution', process.cwd())
    .option('--verbose', 'Log every change that is applied', false);

  const parsed = await program.parseAsync(process.argv);
  const opts = parsed.opts<CliOptions>();

  const normalized: NormalizedOptions = {
    comment: Boolean(opts.comment),
    backup: Boolean(opts.backup),
    dryRun: Boolean(opts.dryRun),
    pattern: normalizeList(opts.pattern, DEFAULT_PATTERNS),
    ignore: normalizeList(opts.ignore, DEFAULT_IGNORES),
    cwd: await resolveCwd(opts.cwd ?? process.cwd()),
    verbose: Boolean(opts.verbose)
  };

  await run(normalized);
}

async function run(options: NormalizedOptions): Promise<void> {
  const files = await fg(options.pattern, {
    cwd: options.cwd,
    ignore: options.ignore,
    onlyFiles: true,
    absolute: true,
    unique: true
  });

  if (files.length === 0) {
    console.log('No files matched the provided patterns.');
    return;
  }

  let totalStatements = 0;
  let changedFiles = 0;
  let skippedStatements = 0;

  for (const file of files) {
    const result = await processFile(file, options);
    totalStatements += result.statements;
    skippedStatements += result.skipped;
    if (result.changed) {
      changedFiles += 1;
      if (options.verbose || options.dryRun) {
        const action = options.comment ? 'commented' : 'removed';
        const prefix = options.dryRun ? '[dry-run]' : 'updated';
        console.log(`${prefix}: ${path.relative(options.cwd, file)} (${result.statements} console statement(s) ${action})`);
      }
    }
  }

  const actionSummary = options.comment ? 'commented' : 'removed';
  console.log(
    `\nProcessed ${files.length} file(s). ${totalStatements} console statement(s) ${actionSummary} across ${changedFiles} file(s).`
  );

  if (skippedStatements > 0) {
    console.log(`Skipped ${skippedStatements} console call(s) that were not standalone statements.`);
  }

  if (options.dryRun) {
    console.log('No files were modified (dry run).');
  }
}

async function processFile(file: string, options: NormalizedOptions): Promise<FileResult> {
  const source = await readFile(file, 'utf8');
  const transformation = transformSource(source, options, file);

  if (!transformation.changed) {
    return { file, statements: 0, changed: false, skipped: transformation.skipped };
  }

  if (options.dryRun) {
    return {
      file,
      statements: transformation.statements,
      changed: true,
      skipped: transformation.skipped
    };
  }

  if (options.backup) {
    await writeFile(`${file}.bak`, source, 'utf8');
  }

  await writeFile(file, transformation.code, 'utf8');

  return {
    file,
    statements: transformation.statements,
    changed: true,
    skipped: transformation.skipped
  };
}

interface TransformationResult {
  code: string;
  statements: number;
  changed: boolean;
  skipped: number;
}

function transformSource(code: string, options: NormalizedOptions, filename: string): TransformationResult {
  let ast;

  try {
    ast = parse(code, {
      sourceType: 'unambiguous',
      sourceFilename: filename,
      plugins: parserPlugins
    });
  } catch (error) {
    console.warn(`Skipping ${filename}: failed to parse (${(error as Error).message}).`);
    return { code, statements: 0, changed: false, skipped: 0 };
  }

  const magic = new MagicString(code);
  const handled = new Set<string>();
  const matches: Array<{ start: number; end: number }> = [];
  let skipped = 0;

  const visit = (path: CallLikePath): void => {
    if (!isConsoleInvocation(path)) {
      return;
    }

    const statement = path.getStatementParent();
    if (!statement || !statement.isExpressionStatement()) {
      skipped += 1;
      return;
    }

    const node = statement.node;
    if (node.start == null || node.end == null) {
      return;
    }

    const key = `${node.start}:${node.end}`;
    if (handled.has(key)) {
      return;
    }
    handled.add(key);
    matches.push({ start: node.start, end: node.end });
  };

  traverse(ast, {
    CallExpression(path: NodePath<t.CallExpression>) {
      visit(path);
    },
    OptionalCallExpression(path: NodePath<t.OptionalCallExpression>) {
      visit(path);
    }
  });

  if (matches.length === 0) {
    return { code, statements: 0, changed: false, skipped };
  }

  // Apply transformations in reverse order to keep ranges stable
  matches
    .sort((a, b) => b.start - a.start)
    .forEach(({ start, end }) => {
      if (options.comment) {
        const snippet = code.slice(start, end);
        magic.overwrite(start, end, commentOut(snippet));
      } else {
        const [removalStart, removalEnd] = expandRemovalRange(code, start, end);
        magic.remove(removalStart, removalEnd);
      }
    });

  return {
    code: magic.toString(),
    statements: matches.length,
    changed: magic.hasChanged(),
    skipped
  };
}

function isConsoleInvocation(path: CallLikePath): boolean {
  const callee = path.get('callee');

  if (Array.isArray(callee)) {
    return false;
  }

  if (callee.isMemberExpression()) {
    const object = callee.get('object');
    if (Array.isArray(object)) {
      return false;
    }
    return isConsoleObject(object as NodePath<t.Expression | t.Super>);
  }

  if (callee.isOptionalMemberExpression()) {
    const object = callee.get('object');
    if (Array.isArray(object)) {
      return false;
    }
    return isConsoleObject(object as NodePath<t.Expression | t.Super>);
  }

  return false;
}

function isConsoleObject(objectPath: NodePath<t.Expression | t.Super>): boolean {
  if (objectPath.isIdentifier({ name: 'console' })) {
    return !objectPath.scope?.hasBinding('console');
  }

  return false;
}

function commentOut(snippet: string): string {
  const newline = snippet.includes('\r\n') ? '\r\n' : '\n';

  return snippet
    .split(/\r?\n/)
    .map((line) => {
      if (line.trim().length === 0) {
        return line;
      }
      const leadingWhitespace = line.match(/^\s*/)?.[0] ?? '';
      const content = line.slice(leadingWhitespace.length);
      return `${leadingWhitespace}// ${content}`;
    })
    .join(newline);
}

function expandRemovalRange(code: string, start: number, end: number): [number, number] {
  let removalStart = start;
  let removalEnd = end;

  const trailing = code.slice(removalEnd);
  const newlineMatch = trailing.match(/^(\s*?)(\r?\n)/);
  if (newlineMatch) {
    removalEnd += newlineMatch[0].length;
    return [removalStart, removalEnd];
  }

  // If statement is the only thing on the line, also remove preceding newline/indentation
  const leadingSegment = code.slice(0, removalStart);
  const leadingMatch = leadingSegment.match(/([\t ]*)(\r?\n)$/);
  if (leadingMatch) {
    removalStart -= leadingMatch[0].length;
  }

  return [removalStart, removalEnd];
}

function normalizeList(value: string[] | string | undefined, fallback: string[]): string[] {
  if (!value) {
    return fallback;
  }

  const items = Array.isArray(value) ? value : value.split(',');
  const expanded = items
    .flatMap((entry) => entry.split(','))
    .map((item) => item.trim())
    .filter(Boolean);

  return expanded.length > 0 ? expanded : fallback;
}

async function resolveCwd(dir: string): Promise<string> {
  const resolved = path.resolve(dir);
  await stat(resolved);
  return resolved;
}

async function getPackageVersion(): Promise<string> {
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);
  const pkgPath = path.resolve(__dirname, '../package.json');

  try {
    await access(pkgPath, fsConstants.R_OK);
    const raw = await readFile(pkgPath, 'utf8');
    const pkg = JSON.parse(raw) as { version?: string };
    return typeof pkg.version === 'string' ? pkg.version : '0.0.0';
  } catch {
    return '0.0.0';
  }
}

// Ensure the module executes when invoked directly
main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});


