# Commands

## Development

```bash
pnpm install          # Install all dependencies
pnpm build            # Build all packages (Turborepo)
pnpm dev              # Watch mode for all packages
```

## Quality

```bash
pnpm lint             # Run oxlint
pnpm format           # Format with oxfmt (import sorting)
pnpm format --check   # Check formatting without fixing
pnpm typecheck        # Type-check all packages
pnpm knip             # Detect unused exports/dependencies
```

## Testing

```bash
pnpm test                    # Run unit tests (Vitest)
pnpm test:integration        # Run integration tests (requires Docker)
```

## Commit Messages

`commitlint.config.js` extends `@commitlint/config-conventional`, enforced by the `commit-msg` lefthook. The 11 allowed types:

| Type       | When to use                                                   |
| ---------- | ------------------------------------------------------------- |
| `feat`     | New user-facing feature                                       |
| `fix`      | Bug fix                                                       |
| `docs`     | Documentation only                                            |
| `style`    | Formatting, whitespace, semicolons — no code-behavior change  |
| `refactor` | Code restructuring with no behavior change                    |
| `perf`     | Performance improvement                                       |
| `test`     | Adding or fixing tests                                        |
| `build`    | Build system, bundler, or external dep changes                |
| `ci`       | CI configuration (`.github/workflows/`, `lefthook.yml`, etc.) |
| `chore`    | Maintenance / housekeeping (release commits, lockfile bumps)  |
| `revert`   | Reverts a prior commit                                        |

Add `!` after the type for a breaking change (e.g. `feat!: replace boxed with neverthrow`). Header is capped at 100 chars; the type must be lowercase.

## Versioning & Release

```bash
pnpm changeset        # Create a changeset
pnpm run version      # Apply changesets and bump versions
pnpm run release      # Build and publish to npm (OIDC Trusted Publishing)
```

**Use `pnpm run` for `version` and `release`** — bare `pnpm version` collides with pnpm's built-in (which silently prints `process.versions` instead of running the changeset script). Bare `pnpm release` happens to work today but `pnpm run` form is consistent and safe.

## Release flow

1. PR merges to `main` → `Version Packages` PR opens (changesets/action) with bumped `package.json` files and consolidated CHANGELOGs.
2. Merging the `Version Packages` PR triggers the `release` workflow, which runs `pnpm run release`.
3. `pnpm run release` runs `pnpm publish -r --access public --no-git-checks`. Auth is via npm Trusted Publishing (OIDC) — there's no `NPM_TOKEN` secret. Each published package needs a Trusted Publisher configured on npmjs.com pointing at this repo + `.github/workflows/release.yml`.
4. The release uses a `RELEASE_PAT` secret rather than the default `GITHUB_TOKEN` so the `Version Packages` PR triggers CI (GitHub's anti-recursion safeguard skips workflows on bot-authored events).
