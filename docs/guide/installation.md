# Installation

## Prerequisites

Before installing temporal-contract, ensure you have:

- **Node.js** 18.x or later
- **TypeScript** 5.0 or later
- **Temporal Server** running (or Temporal Cloud access)

## Package Installation

temporal-contract consists of multiple packages. Install the ones you need:

### Core Packages

::: code-group

```bash [pnpm]
# Contract definitions
pnpm add @temporal-contract/contract

# Worker implementation
pnpm add @temporal-contract/worker unthrown

# Client for executing workflows
pnpm add @temporal-contract/client unthrown

# Required peer dependencies
pnpm add zod @temporalio/client @temporalio/worker @temporalio/workflow
```

```bash [npm]
npm install @temporal-contract/contract
npm install @temporal-contract/worker unthrown
npm install @temporal-contract/client unthrown
npm install zod @temporalio/client @temporalio/worker @temporalio/workflow
```

```bash [yarn]
yarn add @temporal-contract/contract
yarn add @temporal-contract/worker unthrown
yarn add @temporal-contract/client unthrown
yarn add zod @temporalio/client @temporalio/worker @temporalio/workflow
```

:::

::: tip Package Usage

`unthrown` provides the `Result` / `AsyncResult` types used by activities,
workflows, and clients. The same package works in every context — workflows
use it directly without a Temporal-specific wrapper.

If you are upgrading from a previous version that used `neverthrow`, see
[Migrating from neverthrow](/guide/migrating-to-unthrown). If you are coming
from the older `@swan-io/boxed` / `@temporal-contract/boxed` version, see
[Migrating from @swan-io/boxed](/guide/migrating-to-neverthrow).
:::

### Optional Packages

For testing your workflows and activities:

::: code-group

```bash [pnpm]
pnpm add -D @temporal-contract/testing
```

```bash [npm]
npm install --save-dev @temporal-contract/testing
```

```bash [yarn]
yarn add -D @temporal-contract/testing
```

:::

## Temporal Server Setup

You need a running Temporal server. Choose one of these options:

### Option 1: Local Development (Recommended)

Use the Temporal CLI:

```bash
# Install Temporal CLI
brew install temporal

# Start local server
temporal server start-dev
```

The server will be available at `localhost:7233`.

### Option 2: Docker Compose

```yaml
# docker-compose.yml
version: "3.8"
services:
  temporal:
    image: temporalio/auto-setup:latest
    ports:
      - "7233:7233"
    environment:
      - DB=postgresql
      - DB_PORT=5432
      - POSTGRES_USER=temporal
      - POSTGRES_PWD=temporal
      - POSTGRES_SEEDS=postgresql
```

```bash
docker-compose up -d
```

### Option 3: Temporal Cloud

Sign up at [cloud.temporal.io](https://cloud.temporal.io) and use your cloud endpoint.

## TypeScript Configuration

Ensure your `tsconfig.json` includes:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "Node16",
    "moduleResolution": "Node16",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "resolveJsonModule": true,
    "declaration": true,
    "declarationMap": true
  }
}
```

## Project Structure

Recommended project structure:

```
my-temporal-project/
├── src/
│   ├── contracts/
│   │   └── order.contract.ts      # Contract definitions
│   ├── activities/
│   │   └── order.activities.ts    # Activity implementations
│   ├── workflows/
│   │   └── order.workflow.ts      # Workflow implementations
│   ├── client.ts                  # Client setup
│   └── worker.ts                  # Worker setup
├── package.json
└── tsconfig.json
```

## Verify Installation

Create a simple test to verify everything works:

```typescript
// test-installation.ts
import { defineContract } from "@temporal-contract/contract";
import { z } from "zod";

const testContract = defineContract({
  taskQueue: "test",
  workflows: {
    hello: {
      input: z.object({ name: z.string() }),
      output: z.object({ greeting: z.string() }),
      activities: {},
    },
  },
});

console.log("✅ temporal-contract installed successfully!");
console.log("Contract task queue:", testContract.taskQueue);
```

Run it:

```bash
npx tsx test-installation.ts
```

You should see:

```
✅ temporal-contract installed successfully!
Contract task queue: test
```

## Common Issues

### ESM vs CommonJS

temporal-contract uses ESM. Ensure your `package.json` includes:

```json
{
  "type": "module"
}
```

Or use `.mts` file extensions.

### TypeScript Version

Ensure TypeScript 5.0+:

```bash
npx tsc --version
```

### Peer Dependency Warnings

Install all peer dependencies:

```bash
pnpm add zod @temporalio/client @temporalio/worker @temporalio/workflow
```

## Next Steps

- 📚 Follow the [Getting Started](/guide/getting-started) guide
- 🔍 Learn about [Core Concepts](/guide/core-concepts)
- 📖 Explore [Examples](/examples/)
