/**
 * Workflow implementations for `second.contract.ts` — registered on the
 * second worker (own task queue) in the integration suite.
 */
export async function echoWorkflow(args: { text: string }): Promise<{ echoed: string }> {
  return {
    echoed: `second-queue: ${args.text}`,
  };
}
