import {
  proxyActivities,
  sleep,
  setHandler,
  defineSignal,
  defineQuery,
  defineUpdate,
} from "@temporalio/workflow";

import { testContract } from "./test.contract.js";

// Define activity types manually based on the contract
type Activities = {
  logMessage(args: { message: string }): Promise<{}>;
  processMessage(args: { message: string }): Promise<{ processed: string }>;
};

// Create activity proxies
const activities = proxyActivities<Activities>({
  startToCloseTimeout: "1 minute",
});

export async function simpleWorkflow(args: { value: string }) {
  await activities.logMessage({ message: `Processing: ${args.value}` });
  return {
    result: `Processed: ${args.value}`,
  };
}

const incrementSignal = defineSignal<[{ amount: number }]>("increment");
const getCurrentValueQuery = defineQuery<{ value: number }, []>("getCurrentValue");
const multiplyUpdate = defineUpdate<{ newValue: number }, [{ factor: number }]>("multiply");

export async function interactiveWorkflow(args: { initialValue: number }) {
  let currentValue = args.initialValue;

  // Define signal handler
  setHandler(incrementSignal, async ({ amount }) => {
    currentValue += amount;
  });

  // Define query handler
  setHandler(getCurrentValueQuery, () => {
    return { value: currentValue };
  });

  // Define update handler
  setHandler(multiplyUpdate, async ({ factor }) => {
    currentValue *= factor;
    return { newValue: currentValue };
  });

  // Simulate some processing time to allow signals/queries/updates
  await sleep(100);

  return {
    finalValue: currentValue,
  };
}

// Mirrors what `@temporal-contract/worker`'s `declareWorkflow` does at the
// D1 wire boundary: the client transmits the caller's ORIGINAL args, the
// receiving side parses them exactly once, and the return value is handed to
// Temporal untransformed (the client parses the output on receive).
export async function transformWorkflow(args: { text: string }) {
  const parsed = await testContract.workflows.transformWorkflow.input["~standard"].validate(args);
  if (parsed.issues) {
    throw new Error(`transformWorkflow input validation failed`);
  }
  const input = parsed.value as { text: string };
  return {
    handlerSaw: input.text,
    doubled: 21,
  };
}

export async function workflowWithActivity(args: { message: string }) {
  const processed = await activities.processMessage({ message: args.message });
  await activities.logMessage({ message: `Activity result: ${processed.processed}` });
  return {
    result: processed.processed,
  };
}
