# Install temporal-contract

## Requirements

|               |                                                                |
| ------------- | -------------------------------------------------------------- |
| Node.js       | ≥ 22.22.0                                                      |
| Module system | ESM only (`"type": "module"`)                                  |
| TypeScript    | Developed against 6.0; `strict` required for correct inference |
| Temporal SDK  | `@temporalio/*` v1                                             |

## Install the packages

::: warning 8.0 is currently a prerelease
The 8.0 line — the API these docs describe — is published under the `beta`
dist-tag, so a plain `npm install @temporal-contract/contract` still resolves
7.x. Install the `@temporal-contract/*` packages with the explicit `@beta`
tag, as the commands below do. The peer dependencies (`unthrown`,
`@temporalio/*`) are stable releases.
:::

Pick the packages for what you are building. Most applications split across
processes, so each process installs only what it uses.

::: code-group

```bash [pnpm]
# Shared — the contract, imported by every side
pnpm add @temporal-contract/contract@beta

# Worker process
pnpm add @temporal-contract/worker@beta

# Client process
pnpm add @temporal-contract/client@beta

# Tests
pnpm add -D @temporal-contract/testing@beta
```

```bash [npm]
npm install @temporal-contract/contract@beta
npm install @temporal-contract/worker@beta
npm install @temporal-contract/client@beta
npm install -D @temporal-contract/testing@beta
```

```bash [yarn]
yarn add @temporal-contract/contract@beta
yarn add @temporal-contract/worker@beta
yarn add @temporal-contract/client@beta
yarn add -D @temporal-contract/testing@beta
```

:::

All four packages are released as a fixed group — a single version number
describes a compatible set. Do not mix versions.

## Install the peer dependencies

These are peers, not dependencies, because they appear in the packages' public
types. Your code and the library must resolve to the _same_ copy.

| Peer                   | Required by                                  | Range     |
| ---------------------- | -------------------------------------------- | --------- |
| `unthrown`             | contract (optional), worker, client, testing | `^5.0.0`  |
| `@temporalio/common`   | worker, client                               | `^1.16.0` |
| `@temporalio/worker`   | worker, testing                              | `^1.16.0` |
| `@temporalio/workflow` | worker                                       | `^1.16.0` |
| `@temporalio/client`   | client, testing                              | `^1.16.0` |
| `@temporalio/testing`  | testing                                      | `^1.16.0` |
| `vitest`               | testing                                      | `^4`      |
| `testcontainers`       | testing (optional)                           | `^12`     |

Two of these are **optional**:

- `unthrown` is an optional peer of the _contract_ package: defining a
  contract needs no Result machinery, so the package root stays importable
  without it. You only need it there when importing the
  `@temporal-contract/contract/errors` surface — and the worker, client, and
  testing packages require it unconditionally, so in practice any project
  with more than the contract package installs it anyway.
- `testcontainers` is an optional peer of the _testing_ package, needed only
  by `createContractTest` and the `/global-setup` entry (the Dockerized
  Temporal server). The Docker-free entries (`/activity`, `/time-skipping`,
  `/extension`) work without it.

The `@temporalio/*` floor is **1.16.0** — the typed client relies on the
Schedule API wired into `Client` in that release.

The testing package additionally peer-depends on the other three
`@temporal-contract/*` packages — its contract-aware fixtures hand you a
`TypedClient` and run a worker, so it must resolve to _your_ copies of
contract, client, and worker. Installing all four packages (as the commands
above do) satisfies it.

Plus a [Standard Schema](https://standardschema.dev/) library to write your
schemas with — Zod, Valibot, or ArkType.

::: code-group

```bash [Worker process]
pnpm add unthrown zod \
  @temporalio/common @temporalio/worker @temporalio/workflow
```

```bash [Client process]
pnpm add unthrown zod \
  @temporalio/client @temporalio/common
```

```bash [Tests]
pnpm add -D vitest \
  @temporalio/client @temporalio/testing @temporalio/worker
```

:::

::: warning Install `unthrown` explicitly
Even if your package manager auto-installs peers, list `unthrown` in your own
`package.json`. Your code imports its `Result` and `AsyncResult` types
directly, so it is a real dependency of yours — not just of the library.

It must resolve to **v5**. v5 is not compatible with v4; see
[Upgrade to v8](/how-to/upgrade-to-v8).
:::

## Choose a schema library

Any Standard Schema implementation works — the packages themselves are
schema-library-agnostic, so your schemas can be whatever you prefer.

::: code-group

```typescript [Zod]
import { z } from "zod";

const input = z.object({
  orderId: z.string(),
  email: z.email(),
  amount: z.number().positive(),
});
```

```typescript [Valibot]
import * as v from "valibot";

const input = v.object({
  orderId: v.string(),
  email: v.pipe(v.string(), v.email()),
  amount: v.pipe(v.number(), v.minValue(0)),
});
```

```typescript [ArkType]
import { type } from "arktype";

const input = type({
  orderId: "string",
  email: "string.email",
  amount: "number > 0",
});
```

:::

## Configure TypeScript

```json
{
  "compilerOptions": {
    "target": "es2023",
    "module": "nodenext",
    "moduleResolution": "nodenext",
    "strict": true,
    "skipLibCheck": true
  }
}
```

`strict` is not optional in practice. The contract's type inference relies on
it; with `strict: false` you will see `any` leak through where precise types
should be.

## Write imports with `.js` extensions

The packages are ESM-only. Your own relative imports need explicit extensions,
and they must say `.js` even when the file on disk is `.ts`:

```typescript
import { orderContract } from "./contract.js"; // ✅
import { orderContract } from "./contract"; // ❌ ERR_MODULE_NOT_FOUND
import { orderContract } from "./contract.ts"; // ❌
```

## Start a Temporal server

For local development, the CLI's dev server is the fastest route:

```bash
brew install temporal          # macOS
# or: curl -sSf https://temporal.download/cli.sh | sh

temporal server start-dev
```

gRPC on `localhost:7233`, Web UI on <http://localhost:8233>.

For a persistent local cluster, use the official
[docker-compose setup](https://github.com/temporalio/docker-compose).

For tests, you do not need either — see
[Test workflows](/how-to/test-workflows), which covers the in-process
time-skipping server and disposable containers.

## Verify the install

```typescript
// verify.ts
import { defineContract, defineWorkflow } from "@temporal-contract/contract";
import { z } from "zod";

const ping = defineWorkflow({
  input: z.object({ message: z.string() }),
  output: z.object({ echo: z.string() }),
  startPolicy: "allow-duplicate",
});

const contract = defineContract({
  taskQueue: "verify",
  workflows: { ping },
});

console.log("contract ok:", contract.taskQueue);
```

```bash
npx tsx verify.ts
# contract ok: verify
```

If `defineContract` throws, the message names the offending field — it validates
its own structure at call time.

## Next

- [Your first workflow](/tutorial/your-first-workflow) — build something end to
  end.
- [Define a contract](/how-to/define-a-contract) — the contract-authoring
  recipes.
- [Troubleshoot](/how-to/troubleshoot) — if the install did not go smoothly.
