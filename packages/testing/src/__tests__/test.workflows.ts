// Workflow implementation for the fixtures' integration test.
//
// Deliberately written with the raw `@temporalio/workflow` API (like
// packages/client's integration workflows) rather than `declareWorkflow`:
// Temporal's workflow bundler resolves imports through node_modules from
// this file's location, and `@temporal-contract/worker` is a *peer* of this
// package (a dev dep would put a cycle in the workspace package graph), so
// it is not linked here. The typed surface under test — the contract-bound
// client and the worker wiring — is unaffected.
import { proxyActivities } from "@temporalio/workflow";

type Activities = {
  decorate(args: { name: string }): Promise<{ decorated: string }>;
};

const activities = proxyActivities<Activities>({
  startToCloseTimeout: "10 seconds",
});

export async function greet(args: { name: string }): Promise<{ message: string }> {
  const { decorated } = await activities.decorate({ name: args.name });
  return { message: `Hello, ${decorated}!` };
}
