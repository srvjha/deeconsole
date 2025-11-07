## deeconsole

Its a CLI utility for removing or commenting out `console.*` statements across JavaScript and TypeScript codebases. Designed to be published as an npm package, it supports glob-based file targeting, dry runs, backups, and optional comment-based preservation of log statements.

## Installation

You can consume the package globally, as a dev dependency, or via `npx`:

```bash
# Global install (recommended for recurring use)
npm install --global deeconsole

# Project-level dev dependency
npm install --save-dev deeconsole

# On-demand without install
npx deeconsole --help
```

When installed globally or locally, the CLI executable is named `deeconsole`.

## Usage

Run the command from the project root you want to scan. By default it searches for JavaScript and TypeScript files and removes all `console` statements.

```bash
deeconsole
```

### Core Options

- `-c, --comment` – Comment out matching statements instead of deleting them. Each line in the original statement receives a leading `//` while preserving indentation.
- `-b, --backup` – Create a `.bak` copy alongside every file that is modified.
- `--dry-run` – Traverse and report on matches without writing any files. Useful to preview the impact of the run.
- `-p, --pattern <glob...>` – One or more glob patterns (via [fast-glob](https://github.com/mrmlnc/fast-glob)) to include. Defaults to `**/*.{js,jsx,ts,tsx,cjs,mjs,cts,mts}`.
- `-i, --ignore <glob...>` – Glob patterns to exclude (defaults include `node_modules`, build outputs, git metadata, etc.).
- `--cwd <dir>` – Base directory for glob resolution (defaults to the current working directory).
- `--verbose` – Emit a line for every file that changes, showing the number of statements handled.

Display the full help with:

```bash
deeconsole --help
```

## Examples

Remove console statements from the default set of source files:

```bash
deeconsole
```

Comment out every `console.*` call in a specific folder while keeping backups:

```bash
deeconsole --comment --backup --pattern "src/**/*.ts"
```

Preview changes without touching files:

```bash
deeconsole --dry-run --verbose
```

Target only tests and ignore snapshot folders:

```bash
deeconsole \
  --pattern "tests/**/*.{ts,tsx}" \
  --ignore "**/__snapshots__/**"
```

## Behavior

- Handles all member calls on the global `console` object (`console.log`, `console.error`, etc.).
- Ensures only standalone expression statements are removed or commented. Calls embedded in larger expressions are reported as skipped to avoid breaking logic.
- Preserves original line endings and indentation when commenting out statements.
- Supports modern syntax via Babel parser plugins (JSX, TypeScript, decorators, optional chaining, top-level await, etc.).

## Development

```bash
pnpm install
pnpm build
pnpm dev  # Watch mode using ts-node-dev
```

After building, the compiled CLI lives in `dist/index.js` with the execute bit set by the shebang.

## Sample Workflow

1. Install the package globally: `npm install --global deeconsole`.
2. Run `deeconsole --dry-run` in your project root to see how many statements will be touched.
3. Execute `deeconsole --comment` to convert logs into comments for later review, or omit the flag to remove them outright.
4. Inspect `.bak` files if you enabled backups, then delete them when satisfied.

## License

[ISC](./LICENSE) — feel free to adapt the tool to your workflow.
