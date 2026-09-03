import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  defineActivity,
  defineContract,
  defineQuery,
  defineSignal,
  defineUpdate,
  defineWorkflow,
} from "./builder.js";

describe("Contract Builder", () => {
  describe("defineContract", () => {
    it("should create a contract with workflows", () => {
      const contract = defineContract({
        taskQueue: "test-queue",
        workflows: {
          processOrder: {
            input: z.object({ orderId: z.string() }),
            output: z.object({ status: z.string() }),
            startPolicy: "allow-duplicate",
          },
        },
      });

      expect(contract).toEqual(
        expect.objectContaining({
          taskQueue: "test-queue",
          workflows: expect.objectContaining({
            processOrder: expect.objectContaining({
              input: expect.any(Object),
              output: expect.any(Object),
            }),
          }),
        }),
      );
    });

    it("should create a contract with global activities", () => {
      const contract = defineContract({
        taskQueue: "test-queue",
        workflows: {
          simpleWorkflow: {
            input: z.object({ value: z.string() }),
            output: z.object({ result: z.string() }),
            startPolicy: "allow-duplicate",
          },
        },
        activities: {
          sendEmail: {
            input: z.object({ to: z.string(), subject: z.string(), body: z.string() }),
            output: z.object({ sent: z.boolean() }),
          },
        },
      });

      expect(contract).toEqual(
        expect.objectContaining({
          activities: expect.objectContaining({
            sendEmail: expect.objectContaining({
              input: expect.any(Object),
              output: expect.any(Object),
            }),
          }),
        }),
      );
    });

    it("should create a contract with workflow-specific activities", () => {
      const contract = defineContract({
        taskQueue: "test-queue",
        workflows: {
          processOrder: {
            input: z.object({ orderId: z.string() }),
            output: z.object({ status: z.string() }),
            startPolicy: "allow-duplicate",
            activities: {
              validateInventory: {
                input: z.object({ orderId: z.string() }),
                output: z.object({ available: z.boolean() }),
              },
              processPayment: {
                input: z.object({ amount: z.number() }),
                output: z.object({ transactionId: z.string() }),
              },
            },
          },
        },
      });

      expect(contract).toEqual(
        expect.objectContaining({
          workflows: expect.objectContaining({
            processOrder: expect.objectContaining({
              activities: expect.objectContaining({
                validateInventory: expect.objectContaining({
                  input: expect.any(Object),
                  output: expect.any(Object),
                }),
                processPayment: expect.objectContaining({
                  input: expect.any(Object),
                  output: expect.any(Object),
                }),
              }),
            }),
          }),
        }),
      );
    });

    it("should support signals in workflow definitions", () => {
      const contract = defineContract({
        taskQueue: "test-queue",
        workflows: {
          processOrder: {
            input: z.object({ orderId: z.string() }),
            output: z.object({ status: z.string() }),
            startPolicy: "allow-duplicate",
            signals: {
              cancel: {
                input: z.object({ reason: z.string() }),
              },
              addItem: {
                input: z.object({ itemId: z.string(), quantity: z.number() }),
              },
            },
          },
        },
      });

      expect(contract).toEqual(
        expect.objectContaining({
          workflows: expect.objectContaining({
            processOrder: expect.objectContaining({
              signals: expect.objectContaining({
                cancel: expect.objectContaining({
                  input: expect.any(Object),
                }),
                addItem: expect.objectContaining({
                  input: expect.any(Object),
                }),
              }),
            }),
          }),
        }),
      );
    });

    it("should support queries in workflow definitions", () => {
      const contract = defineContract({
        taskQueue: "test-queue",
        workflows: {
          processOrder: {
            input: z.object({ orderId: z.string() }),
            output: z.object({ status: z.string() }),
            startPolicy: "allow-duplicate",
            queries: {
              getStatus: {
                input: z.object({}),
                output: z.object({ status: z.string(), progress: z.number() }),
              },
              getTotal: {
                input: z.object({}),
                output: z.object({ amount: z.number() }),
              },
            },
          },
        },
      });

      expect(contract).toEqual(
        expect.objectContaining({
          workflows: expect.objectContaining({
            processOrder: expect.objectContaining({
              queries: expect.objectContaining({
                getStatus: expect.objectContaining({
                  input: expect.any(Object),
                  output: expect.any(Object),
                }),
                getTotal: expect.objectContaining({
                  input: expect.any(Object),
                  output: expect.any(Object),
                }),
              }),
            }),
          }),
        }),
      );
    });

    it("should support updates in workflow definitions", () => {
      const contract = defineContract({
        taskQueue: "test-queue",
        workflows: {
          processOrder: {
            input: z.object({ orderId: z.string() }),
            output: z.object({ status: z.string() }),
            startPolicy: "allow-duplicate",
            updates: {
              updateDiscount: {
                input: z.object({ percentage: z.number() }),
                output: z.object({ newTotal: z.number() }),
              },
              updateShippingAddress: {
                input: z.object({ address: z.string() }),
                output: z.object({ updated: z.boolean() }),
              },
            },
          },
        },
      });

      expect(contract).toEqual(
        expect.objectContaining({
          workflows: expect.objectContaining({
            processOrder: expect.objectContaining({
              updates: expect.objectContaining({
                updateDiscount: expect.objectContaining({
                  input: expect.any(Object),
                  output: expect.any(Object),
                }),
                updateShippingAddress: expect.objectContaining({
                  input: expect.any(Object),
                  output: expect.any(Object),
                }),
              }),
            }),
          }),
        }),
      );
    });

    it("should support multiple workflows", () => {
      const contract = defineContract({
        taskQueue: "test-queue",
        workflows: {
          processOrder: {
            input: z.object({ orderId: z.string() }),
            output: z.object({ status: z.string() }),
            startPolicy: "allow-duplicate",
          },
          cancelOrder: {
            input: z.object({ orderId: z.string(), reason: z.string() }),
            output: z.object({ cancelled: z.boolean() }),
            startPolicy: "allow-duplicate",
          },
          refundOrder: {
            input: z.object({ orderId: z.string(), amount: z.number() }),
            output: z.object({ refunded: z.boolean(), transactionId: z.string() }),
            startPolicy: "allow-duplicate",
          },
        },
      });

      expect(contract).toEqual(
        expect.objectContaining({
          workflows: expect.objectContaining({
            processOrder: expect.any(Object),
            cancelOrder: expect.any(Object),
            refundOrder: expect.any(Object),
          }),
        }),
      );
    });

    it("should validate single parameter pattern", () => {
      const contract = defineContract({
        taskQueue: "test-queue",
        workflows: {
          simpleWorkflow: {
            input: z.string(), // Single primitive
            output: z.object({ result: z.string() }),
            startPolicy: "allow-duplicate",
          },
          complexWorkflow: {
            input: z.object({
              // Object with multiple properties
              orderId: z.string(),
              customerId: z.string(),
              amount: z.number(),
            }),
            output: z.object({ success: z.boolean() }),
            startPolicy: "allow-duplicate",
          },
          arrayWorkflow: {
            input: z.array(
              z.object({
                // Array of objects
                id: z.string(),
                value: z.number(),
              }),
            ),
            output: z.object({ processed: z.number() }),
            startPolicy: "allow-duplicate",
          },
        },
      });

      expect(contract).toEqual(
        expect.objectContaining({
          workflows: expect.objectContaining({
            simpleWorkflow: expect.objectContaining({ input: expect.anything() }),
            complexWorkflow: expect.objectContaining({ input: expect.anything() }),
            arrayWorkflow: expect.objectContaining({ input: expect.anything() }),
          }),
        }),
      );
    });

    it("should preserve type information", () => {
      const contract = defineContract({
        taskQueue: "my-queue",
        workflows: {
          myWorkflow: {
            input: z.object({ id: z.string() }),
            output: z.object({ success: z.boolean() }),
            startPolicy: "allow-duplicate",
          },
        },
      });

      expect(contract).toEqual(
        expect.objectContaining({
          taskQueue: "my-queue",
        }),
      );
    });
  });

  describe("defineContract validation", () => {
    it("should throw when taskQueue is empty", () => {
      expect(() =>
        defineContract({
          taskQueue: "",
          workflows: {
            test: {
              input: z.object({}),
              output: z.object({}),
              startPolicy: "allow-duplicate",
            },
          },
        }),
      ).toThrow("taskQueue cannot be empty");
    });

    it("should throw when taskQueue is only whitespace", () => {
      expect(() =>
        defineContract({
          taskQueue: "   ",
          workflows: {
            test: {
              input: z.object({}),
              output: z.object({}),
              startPolicy: "allow-duplicate",
            },
          },
        }),
      ).toThrow("Contract validation failed");
    });

    it("should throw when neither workflows nor global activities are defined", () => {
      expect(() =>
        defineContract({
          taskQueue: "test",
          workflows: {},
        }),
      ).toThrow("at least one workflow or global activity is required");
    });

    it("should accept an activity-only contract (zero workflows)", () => {
      const contract = defineContract({
        taskQueue: "activity-pool",
        workflows: {},
        activities: {
          sendEmail: {
            input: z.object({ to: z.string() }),
            output: z.object({ sent: z.boolean() }),
          },
        },
      });

      expect(contract.workflows).toEqual({});
      expect(contract.activities.sendEmail).toBeDefined();
    });

    it("should throw when workflow name is invalid", () => {
      expect(() =>
        defineContract({
          taskQueue: "test",
          workflows: {
            "invalid-name": {
              input: z.object({}),
              output: z.object({}),
              startPolicy: "allow-duplicate",
            },
          },
        }),
      ).toThrow("must be a valid JavaScript identifier");
    });

    it("should throw when global activity name is invalid", () => {
      expect(() =>
        defineContract({
          taskQueue: "test",
          workflows: {
            test: {
              input: z.object({}),
              output: z.object({}),
              startPolicy: "allow-duplicate",
            },
          },
          activities: {
            "send-email": {
              input: z.object({}),
              output: z.object({}),
            },
          },
        }),
      ).toThrow("must be a valid JavaScript identifier");
    });

    it("should throw when workflow activity conflicts with global activity", () => {
      expect(() =>
        defineContract({
          taskQueue: "test",
          workflows: {
            processOrder: {
              input: z.object({}),
              output: z.object({}),
              startPolicy: "allow-duplicate",
              activities: {
                sendEmail: {
                  input: z.object({}),
                  output: z.object({}),
                },
              },
            },
          },
          activities: {
            sendEmail: {
              input: z.object({}),
              output: z.object({}),
            },
          },
        }),
      ).toThrow(
        'workflow "processOrder" has activity "sendEmail" that conflicts with a different global activity of the same name. Activities share a single flat namespace at runtime — reference the shared definition from the contract\'s global "activities" block, or rename one of them.',
      );
    });

    it("should throw when two workflows declare activities with the same name", () => {
      expect(() =>
        defineContract({
          taskQueue: "test",
          workflows: {
            processOrder: {
              input: z.object({}),
              output: z.object({}),
              startPolicy: "allow-duplicate",
              activities: {
                charge: {
                  input: z.object({}),
                  output: z.object({}),
                },
              },
            },
            processRefund: {
              input: z.object({}),
              output: z.object({}),
              startPolicy: "allow-duplicate",
              activities: {
                charge: {
                  input: z.object({}),
                  output: z.object({}),
                },
              },
            },
          },
        }),
      ).toThrow(
        'workflow "processRefund" has activity "charge" that conflicts with a different same-named activity in workflow "processOrder". Activities share a single flat namespace at runtime — hoist the shared activity to the contract\'s global "activities" block, or rename one of them.',
      );
    });

    it("should allow the same activity object to be shared by two workflows", () => {
      const charge = defineActivity({
        input: z.object({ amount: z.number() }),
        output: z.object({ transactionId: z.string() }),
      });

      expect(() =>
        defineContract({
          taskQueue: "test",
          workflows: {
            processOrder: {
              input: z.object({}),
              output: z.object({}),
              startPolicy: "allow-duplicate",
              activities: { charge },
            },
            processRefund: {
              input: z.object({}),
              output: z.object({}),
              startPolicy: "allow-duplicate",
              activities: { charge },
            },
          },
        }),
      ).not.toThrow();
    });

    it("should allow a workflow to reference the same object as a global activity", () => {
      const sendEmail = defineActivity({
        input: z.object({ to: z.string() }),
        output: z.object({ sent: z.boolean() }),
      });

      expect(() =>
        defineContract({
          taskQueue: "test",
          workflows: {
            processOrder: {
              input: z.object({}),
              output: z.object({}),
              startPolicy: "allow-duplicate",
              activities: { sendEmail },
            },
          },
          activities: { sendEmail },
        }),
      ).not.toThrow();
    });

    it("should throw when a global activity has the same name as a workflow", () => {
      expect(() =>
        defineContract({
          taskQueue: "test",
          workflows: {
            processOrder: {
              input: z.object({}),
              output: z.object({}),
              startPolicy: "allow-duplicate",
            },
          },
          activities: {
            processOrder: {
              input: z.object({}),
              output: z.object({}),
            },
          },
        }),
      ).toThrow(
        'global activity "processOrder" has the same name as a workflow. Workflows and global activities share the root of the worker implementations map — rename one of them.',
      );
    });

    it("should throw when a workflow has the same name as a global activity", () => {
      // Same collision, declared the other way around: the activity name
      // comes first alphabetically and the workflow map holds several keys.
      expect(() =>
        defineContract({
          taskQueue: "test",
          workflows: {
            aWorkflow: {
              input: z.object({}),
              output: z.object({}),
              startPolicy: "allow-duplicate",
            },
            sendEmail: {
              input: z.object({}),
              output: z.object({}),
              startPolicy: "allow-duplicate",
            },
          },
          activities: {
            sendEmail: {
              input: z.object({}),
              output: z.object({}),
            },
          },
        }),
      ).toThrow(
        'global activity "sendEmail" has the same name as a workflow. Workflows and global activities share the root of the worker implementations map — rename one of them.',
      );
    });

    it("should allow a workflow-local activity to share a workflow's name", () => {
      // Workflow-local activity implementations nest under their owning
      // workflow in the worker implementations map, so they never collide
      // with workflow names at the root.
      expect(() =>
        defineContract({
          taskQueue: "test",
          workflows: {
            processOrder: {
              input: z.object({}),
              output: z.object({}),
              startPolicy: "allow-duplicate",
              activities: {
                processOrder: {
                  input: z.object({}),
                  output: z.object({}),
                },
              },
            },
          },
        }),
      ).not.toThrow();
    });

    it("should not misclassify a workflow named 'global' as the global activity scope", () => {
      // A workflow can legally be named "global" — the collision detector must
      // not confuse it with the global activity scope sentinel.
      expect(() =>
        defineContract({
          taskQueue: "test",
          workflows: {
            global: {
              input: z.object({}),
              output: z.object({}),
              startPolicy: "allow-duplicate",
              activities: {
                send: {
                  input: z.object({}),
                  output: z.object({}),
                },
              },
            },
            other: {
              input: z.object({}),
              output: z.object({}),
              startPolicy: "allow-duplicate",
              activities: {
                send: {
                  input: z.object({}),
                  output: z.object({}),
                },
              },
            },
          },
        }),
      ).toThrow(
        'workflow "other" has activity "send" that conflicts with a different same-named activity in workflow "global". Activities share a single flat namespace at runtime — hoist the shared activity to the contract\'s global "activities" block, or rename one of them.',
      );
    });

    it("should throw when signal name is invalid", () => {
      expect(() =>
        defineContract({
          taskQueue: "test",
          workflows: {
            test: {
              input: z.object({}),
              output: z.object({}),
              startPolicy: "allow-duplicate",
              signals: {
                "cancel-order": {
                  input: z.object({}),
                },
              },
            },
          },
        }),
      ).toThrow("must be a valid JavaScript identifier");
    });

    it("should throw when query name is invalid", () => {
      expect(() =>
        defineContract({
          taskQueue: "test",
          workflows: {
            test: {
              input: z.object({}),
              output: z.object({}),
              startPolicy: "allow-duplicate",
              queries: {
                "get-status": {
                  input: z.object({}),
                  output: z.object({}),
                },
              },
            },
          },
        }),
      ).toThrow("must be a valid JavaScript identifier");
    });

    it("should throw when update name is invalid", () => {
      expect(() =>
        defineContract({
          taskQueue: "test",
          workflows: {
            test: {
              input: z.object({}),
              output: z.object({}),
              startPolicy: "allow-duplicate",
              updates: {
                "update-amount": {
                  input: z.object({}),
                  output: z.object({}),
                },
              },
            },
          },
        }),
      ).toThrow("must be a valid JavaScript identifier");
    });

    it("should allow valid camelCase names", () => {
      expect(() =>
        defineContract({
          taskQueue: "test-queue",
          workflows: {
            processOrder: {
              input: z.object({}),
              output: z.object({}),
              startPolicy: "allow-duplicate",
              activities: {
                sendEmail: {
                  input: z.object({}),
                  output: z.object({}),
                },
              },
              signals: {
                cancelOrder: {
                  input: z.object({}),
                },
              },
              queries: {
                getStatus: {
                  input: z.object({}),
                  output: z.object({}),
                },
              },
              updates: {
                updateAmount: {
                  input: z.object({}),
                  output: z.object({}),
                },
              },
            },
          },
        }),
      ).not.toThrow();
    });

    it("should allow names with underscores and dollar signs", () => {
      expect(() =>
        defineContract({
          taskQueue: "test",
          workflows: {
            process_order: {
              input: z.object({}),
              output: z.object({}),
              startPolicy: "allow-duplicate",
            },
            $process: {
              input: z.object({}),
              output: z.object({}),
              startPolicy: "allow-duplicate",
            },
          },
          activities: {
            send_email: {
              input: z.object({}),
              output: z.object({}),
            },
            $send: {
              input: z.object({}),
              output: z.object({}),
            },
          },
        }),
      ).not.toThrow();
    });

    it("should throw on an unknown top-level key (strict root)", () => {
      expect(() =>
        defineContract({
          taskQueue: "test",
          workflows: {
            test: {
              input: z.object({}),
              output: z.object({}),
              startPolicy: "allow-duplicate",
            },
          },
          // Deliberate typo of `activities` — TypeScript's generic inference
          // absorbs the extra key, which is exactly why the runtime root
          // check is strict.
          activites: {},
        }),
      ).toThrow(
        'contract has unknown key "activites" — allowed keys are "taskQueue", "workflows", "activities"',
      );
    });

    it("should accept input-less signal/query/update definitions from the helpers", () => {
      expect(() =>
        defineContract({
          taskQueue: "test",
          workflows: {
            wf: defineWorkflow({
              input: z.object({}),
              output: z.object({}),
              startPolicy: "allow-duplicate",
              signals: { shutdown: defineSignal() },
              queries: { getStatus: defineQuery({ output: z.string() }) },
              updates: { bump: defineUpdate({ output: z.number() }) },
            }),
          },
        }),
      ).not.toThrow();
    });
  });

  describe("Edge Cases", () => {
    it("should handle empty object schemas", () => {
      const contract = defineContract({
        taskQueue: "test",
        workflows: {
          empty: {
            input: z.object({}),
            output: z.object({}),
            startPolicy: "allow-duplicate",
          },
        },
      });
      expect(contract).toEqual(
        expect.objectContaining({
          workflows: expect.objectContaining({
            empty: expect.objectContaining({
              input: expect.any(Object),
              output: expect.any(Object),
            }),
          }),
        }),
      );
    });

    it("should handle void input", () => {
      const contract = defineContract({
        taskQueue: "test",
        workflows: {
          noInput: {
            input: z.void(),
            output: z.object({ result: z.string() }),
            startPolicy: "allow-duplicate",
          },
        },
      });
      expect(contract).toEqual(
        expect.objectContaining({
          workflows: expect.objectContaining({
            noInput: expect.objectContaining({
              input: expect.any(Object),
              output: expect.any(Object),
            }),
          }),
        }),
      );
    });

    it("should handle workflows without activities, signals, queries, or updates", () => {
      const contract = defineContract({
        taskQueue: "test",
        workflows: {
          simple: {
            input: z.string(),
            output: z.string(),
            startPolicy: "allow-duplicate",
          },
        },
      });
      const workflow = contract.workflows.simple;
      expect(workflow).toEqual(
        expect.objectContaining({ input: expect.anything(), output: expect.anything() }),
      );
      expect("activities" in workflow).toBe(false);
      expect("signals" in workflow).toBe(false);
      expect("queries" in workflow).toBe(false);
      expect("updates" in workflow).toBe(false);
    });

    it("should handle contract without global activities", () => {
      const contract = defineContract({
        taskQueue: "test",
        workflows: {
          test: {
            input: z.object({}),
            output: z.object({}),
            startPolicy: "allow-duplicate",
          },
        },
      });
      expect(contract).toEqual(expect.objectContaining({ workflows: expect.any(Object) }));
      expect("activities" in contract).toBe(false);
    });

    it("should throw when workflow is missing input", () => {
      expect(() =>
        defineContract({
          taskQueue: "test",
          workflows: {
            // @ts-expect-error - Testing validation with missing input
            test: {
              output: z.object({}),
              startPolicy: "allow-duplicate",
            },
          },
        }),
      ).toThrow("Contract validation failed");
    });

    it("should throw when workflow is missing output", () => {
      expect(() =>
        defineContract({
          taskQueue: "test",
          workflows: {
            // @ts-expect-error - Testing validation with missing output
            test: {
              input: z.object({}),
              startPolicy: "allow-duplicate",
            },
          },
        }),
      ).toThrow("Contract validation failed");
    });

    it("should throw when workflow startPolicy is an invalid string", () => {
      expect(() =>
        defineContract({
          taskQueue: "test",
          workflows: {
            test: {
              input: z.object({}),
              output: z.object({}),
              // @ts-expect-error - Testing validation with an invalid startPolicy literal
              startPolicy: "sometimes",
            },
          },
        }),
      ).toThrow(
        'Contract validation failed: workflow "test": startPolicy must be "once-per-id", "retry-if-failed", or "allow-duplicate"',
      );
    });

    it("should throw when workflow startPolicy is not a string", () => {
      expect(() =>
        defineContract({
          taskQueue: "test",
          workflows: {
            test: {
              input: z.object({}),
              output: z.object({}),
              // @ts-expect-error - Testing validation with a non-string startPolicy
              startPolicy: 42,
            },
          },
        }),
      ).toThrow("Contract validation failed");
    });

    it("should throw when activity is missing input", () => {
      expect(() =>
        defineContract({
          taskQueue: "test",
          workflows: {
            test: {
              input: z.object({}),
              output: z.object({}),
              startPolicy: "allow-duplicate",
            },
          },
          activities: {
            // @ts-expect-error - Testing validation with missing input
            test: {
              output: z.object({}),
            },
          },
        }),
      ).toThrow("Contract validation failed");
    });

    it("should throw when activity is missing output", () => {
      expect(() =>
        defineContract({
          taskQueue: "test",
          workflows: {
            test: {
              input: z.object({}),
              output: z.object({}),
              startPolicy: "allow-duplicate",
            },
          },
          activities: {
            // @ts-expect-error - Testing validation with missing output
            test: {
              input: z.object({}),
            },
          },
        }),
      ).toThrow("Contract validation failed");
    });

    it("should throw when workflow activity name is invalid", () => {
      expect(() =>
        defineContract({
          taskQueue: "test",
          workflows: {
            test: {
              input: z.object({}),
              output: z.object({}),
              startPolicy: "allow-duplicate",
              activities: {
                "invalid-name": {
                  input: z.object({}),
                  output: z.object({}),
                },
              },
            },
          },
        }),
      ).toThrow("must be a valid JavaScript identifier");
    });

    it("should throw when input is not a Zod schema", () => {
      expect(() =>
        defineContract({
          taskQueue: "test",
          workflows: {
            test: {
              // @ts-expect-error - Testing validation with invalid input type
              input: "not a schema",
              output: z.object({}),
              startPolicy: "allow-duplicate",
            },
          },
        }),
      ).toThrow("Contract validation failed");
    });

    it("should throw when output is not a Zod schema", () => {
      expect(() =>
        defineContract({
          taskQueue: "test",
          workflows: {
            test: {
              input: z.object({}),
              // @ts-expect-error - Testing validation with invalid output type
              output: { invalid: true },
              startPolicy: "allow-duplicate",
            },
          },
        }),
      ).toThrow("Contract validation failed");
    });
  });

  describe("Standard Schema compatibility", () => {
    it("should work with Valibot schemas", async () => {
      const v = await import("valibot");

      const contract = defineContract({
        taskQueue: "test-queue",
        workflows: {
          processOrder: {
            input: v.object({ orderId: v.string() }),
            output: v.object({ status: v.string() }),
            startPolicy: "allow-duplicate",
          },
        },
        activities: {
          sendEmail: {
            input: v.object({ to: v.string(), subject: v.string() }),
            output: v.object({ sent: v.boolean() }),
          },
        },
      });

      expect(contract).toEqual(
        expect.objectContaining({
          taskQueue: "test-queue",
          workflows: expect.objectContaining({ processOrder: expect.any(Object) }),
          activities: expect.objectContaining({ sendEmail: expect.any(Object) }),
        }),
      );

      // Verify Standard Schema properties exist
      expect(contract.workflows.processOrder.input["~standard"]).toBeDefined();
      expect(contract.workflows.processOrder.input["~standard"].version).toBe(1);
      expect(contract.workflows.processOrder.input["~standard"].vendor).toBe("valibot");
    });

    it("should work with ArkType schemas", async () => {
      const { type } = await import("arktype");

      const contract = defineContract({
        taskQueue: "test-queue",
        workflows: {
          processOrder: {
            input: type({ orderId: "string" }),
            output: type({ status: "string" }),
            startPolicy: "allow-duplicate",
          },
        },
        activities: {
          validatePayment: {
            input: type({ amount: "number" }),
            output: type({ valid: "boolean" }),
          },
        },
      });

      expect(contract).toEqual(
        expect.objectContaining({
          taskQueue: "test-queue",
          workflows: expect.objectContaining({ processOrder: expect.any(Object) }),
          activities: expect.objectContaining({ validatePayment: expect.any(Object) }),
        }),
      );

      // Verify Standard Schema properties exist
      expect(contract.workflows.processOrder.input["~standard"]).toBeDefined();
      expect(contract.workflows.processOrder.input["~standard"].version).toBe(1);
      expect(contract.workflows.processOrder.input["~standard"].vendor).toBe("arktype");
    });

    it("should work with mixed validation libraries", async () => {
      const v = await import("valibot");
      const { type } = await import("arktype");

      const contract = defineContract({
        taskQueue: "test-queue",
        workflows: {
          processZod: {
            input: z.object({ id: z.string() }),
            output: z.object({ result: z.string() }),
            startPolicy: "allow-duplicate",
          },
          processValibot: {
            input: v.object({ id: v.string() }),
            output: v.object({ result: v.string() }),
            startPolicy: "allow-duplicate",
          },
          processArkType: {
            input: type({ id: "string" }),
            output: type({ result: "string" }),
            startPolicy: "allow-duplicate",
          },
        },
      });

      expect(contract).toEqual(
        expect.objectContaining({
          workflows: expect.objectContaining({
            processZod: expect.any(Object),
            processValibot: expect.any(Object),
            processArkType: expect.any(Object),
          }),
        }),
      );

      // Verify each has correct vendor
      expect(contract.workflows.processZod.input["~standard"].vendor).toBe("zod");
      expect(contract.workflows.processValibot.input["~standard"].vendor).toBe("valibot");
      expect(contract.workflows.processArkType.input["~standard"].vendor).toBe("arktype");
    });
  });
});

describe("Contract Builder — typed errors and default options", () => {
  it("accepts errors maps on activities and workflows", () => {
    const contract = defineContract({
      taskQueue: "test-queue",
      workflows: {
        processOrder: {
          input: z.object({ orderId: z.string() }),
          output: z.object({ status: z.string() }),
          startPolicy: "allow-duplicate",
          errors: {
            EmptyOrder: { data: z.object({ orderId: z.string() }) },
          },
          activities: {
            chargePayment: {
              input: z.object({ amount: z.number() }),
              output: z.object({ transactionId: z.string() }),
              errors: {
                PaymentDeclined: {
                  data: z.object({ reason: z.string() }),
                  message: "The payment was declined",
                  nonRetryable: true,
                },
                GatewayUnavailable: {},
              },
            },
          },
        },
      },
    });

    expect(contract.workflows.processOrder.errors.EmptyOrder).toBeDefined();
    expect(
      contract.workflows.processOrder.activities.chargePayment.errors.PaymentDeclined.nonRetryable,
    ).toBe(true);
  });

  it("rejects an error data schema that is not Standard Schema compatible", () => {
    expect(() =>
      defineContract({
        taskQueue: "test-queue",
        workflows: {
          processOrder: {
            input: z.object({}),
            output: z.object({}),
            startPolicy: "allow-duplicate",
            activities: {
              chargePayment: {
                input: z.object({}),
                output: z.object({}),
                errors: {
                  // @ts-expect-error — deliberately not a schema
                  PaymentDeclined: { data: { not: "a schema" } },
                },
              },
            },
          },
        },
      }),
    ).toThrow(/data must be a Standard Schema compatible schema/);
  });

  it("accepts contract-level activityOptions", () => {
    const contract = defineContract({
      taskQueue: "test-queue",
      workflows: {
        processOrder: {
          input: z.object({}),
          output: z.object({}),
          startPolicy: "allow-duplicate",
        },
      },
      activities: {
        sendEmail: {
          input: z.object({ to: z.string() }),
          output: z.void(),
          activityOptions: {
            startToCloseTimeout: "30 seconds",
            heartbeatTimeout: 5_000,
            retry: { maximumAttempts: 5, nonRetryableErrorTypes: ["RecipientRejected"] },
          },
        },
      },
    });

    expect(contract.activities.sendEmail.activityOptions?.startToCloseTimeout).toBe("30 seconds");
  });

  it("rejects a typo'd activityOptions key (strict object)", () => {
    expect(() =>
      defineContract({
        taskQueue: "test-queue",
        workflows: {
          processOrder: {
            input: z.object({}),
            output: z.object({}),
            startPolicy: "allow-duplicate",
          },
        },
        activities: {
          sendEmail: {
            input: z.object({}),
            output: z.void(),
            // @ts-expect-error — deliberate typo
            activityOptions: { startToCloseTimeOut: "30 seconds" },
          },
        },
      }),
    ).toThrow('global activity "sendEmail" activityOptions has unknown key "startToCloseTimeOut"');
  });

  it("rejects a typo'd retry key inside activityOptions (strict object)", () => {
    expect(() =>
      defineContract({
        taskQueue: "test-queue",
        workflows: {
          processOrder: {
            input: z.object({}),
            output: z.object({}),
            startPolicy: "allow-duplicate",
          },
        },
        activities: {
          sendEmail: {
            input: z.object({}),
            output: z.void(),
            activityOptions: {
              // @ts-expect-error — deliberate typo
              retry: { maxAttempts: 3 },
            },
          },
        },
      }),
    ).toThrow(/Contract validation failed/);
  });
});

describe("Contract Builder — duration validation", () => {
  const withTimeout = (startToCloseTimeout: string | number) =>
    defineContract({
      taskQueue: "test-queue",
      workflows: {},
      activities: {
        sendEmail: {
          input: z.object({}),
          output: z.void(),
          activityOptions: { startToCloseTimeout },
        },
      },
    });

  it.each(["5 minutes", "30s", "1.5h", "100", "2 days", "1 y", ".5m", "500ms"])(
    "accepts the ms-formatted duration %j",
    (value) => {
      expect(() => withTimeout(value)).not.toThrow();
    },
  );

  it("accepts a number of milliseconds", () => {
    expect(() => withTimeout(30_000)).not.toThrow();
  });

  it.each(["5 minutos", "", "abc", "30 s econds", "1..5h", "-30s"])(
    "rejects the invalid duration string %j with the offending path and value",
    (value) => {
      expect(() => withTimeout(value)).toThrow(
        `global activity "sendEmail" activityOptions: startToCloseTimeout has invalid duration "${value}"`,
      );
    },
  );

  it("rejects negative and non-finite numeric durations", () => {
    expect(() => withTimeout(-1)).toThrow(/startToCloseTimeout has invalid duration -1/);
    expect(() => withTimeout(Number.POSITIVE_INFINITY)).toThrow(/invalid duration Infinity/);
  });

  it("validates retry intervals with the same grammar", () => {
    expect(() =>
      defineContract({
        taskQueue: "test-queue",
        workflows: {},
        activities: {
          sendEmail: {
            input: z.object({}),
            output: z.void(),
            activityOptions: { retry: { initialInterval: "quick" } },
          },
        },
      }),
    ).toThrow(
      'global activity "sendEmail" activityOptions.retry: initialInterval has invalid duration "quick"',
    );
  });
});

describe("Contract Builder — Temporal-reserved names", () => {
  const RESERVED_MESSAGE = /is reserved by Temporal/;

  it("rejects a workflow name starting with __temporal_", () => {
    expect(() =>
      defineContract({
        taskQueue: "test",
        workflows: {
          __temporal_cleanup: {
            input: z.object({}),
            output: z.object({}),
            startPolicy: "allow-duplicate",
          },
        },
      }),
    ).toThrow(RESERVED_MESSAGE);
  });

  it("rejects the exact reserved query names", () => {
    for (const reserved of ["__stack_trace", "__enhanced_stack_trace"]) {
      expect(() =>
        defineContract({
          taskQueue: "test",
          workflows: {
            wf: {
              input: z.object({}),
              output: z.object({}),
              startPolicy: "allow-duplicate",
              queries: {
                [reserved]: { input: z.object({}), output: z.object({}) },
              },
            },
          },
        }),
      ).toThrow(RESERVED_MESSAGE);
    }
  });

  it("rejects reserved global activity, workflow activity, signal, and update names", () => {
    const base = { input: z.object({}), output: z.object({}) };

    expect(() =>
      defineContract({
        taskQueue: "test",
        workflows: {},
        activities: { __temporal_probe: base },
      }),
    ).toThrow(RESERVED_MESSAGE);

    expect(() =>
      defineContract({
        taskQueue: "test",
        workflows: {
          // @ts-expect-error — reserved workflow-scoped activity name.
          wf: { ...base, activities: { __temporal_probe: base } },
        },
      }),
    ).toThrow(RESERVED_MESSAGE);

    expect(() =>
      defineContract({
        taskQueue: "test",
        workflows: {
          // @ts-expect-error — reserved signal name.
          wf: { ...base, signals: { __temporal_ping: { input: z.object({}) } } },
        },
      }),
    ).toThrow(RESERVED_MESSAGE);

    expect(() =>
      defineContract({
        taskQueue: "test",
        workflows: {
          // @ts-expect-error — reserved update name (one of the two exact
          // stack-trace query names, reused here on an update).
          wf: { ...base, updates: { __stack_trace: base } },
        },
      }),
    ).toThrow(RESERVED_MESSAGE);
  });

  it("still allows ordinary double-underscore names", () => {
    expect(() =>
      defineContract({
        taskQueue: "test",
        workflows: {
          __internal_wf: {
            input: z.object({}),
            output: z.object({}),
            startPolicy: "allow-duplicate",
          },
        },
      }),
    ).not.toThrow();
  });
});
