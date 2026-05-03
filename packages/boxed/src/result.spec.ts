import { describe, expect, it } from "vitest";
import { Result } from "./result.js";

describe("Result", () => {
  describe("Ok", () => {
    it("should create Ok result", () => {
      // GIVEN
      const result = Result.Ok(42);

      // WHEN

      // THEN
      expect(result.isOk()).toBe(true);
      expect(result.isError()).toBe(false);
      if (result.isOk()) {
        expect(result.value).toBe(42);
      }
    });

    it("should map Ok values", () => {
      // GIVEN
      const result = Result.Ok(42);

      // WHEN
      const mapped = result.map((x) => x * 2);

      // THEN
      expect(mapped).toEqual(Result.Ok(84));
    });

    it("should flatMap Ok values", () => {
      // GIVEN
      const result = Result.Ok(42);

      // WHEN
      const flatMapped = result.flatMap((x) => Result.Ok(x * 2));

      // THEN
      expect(flatMapped).toEqual(Result.Ok(84));
    });

    it("should not mapError on Ok values", () => {
      // GIVEN
      const result = Result.Ok(42);

      // WHEN
      const mapped = result.mapError((e: string) => `Error: ${e}`);

      // THEN
      expect(mapped).toEqual(Result.Ok(42));
    });

    it("should match Ok values", () => {
      // GIVEN
      const result = Result.Ok(42);

      // WHEN
      const value = result.match({
        Ok: (value) => value * 2,
        Error: () => 0,
      });

      // THEN
      expect(value).toBe(84);
    });

    it("should getOr return the value", () => {
      // GIVEN
      const result = Result.Ok(42);

      // WHEN
      const value = result.getOr(0);

      // THEN
      expect(value).toBe(42);
    });
  });

  describe("Error", () => {
    it("should create Error result", () => {
      // GIVEN
      const result = Result.Error("error message");

      // WHEN

      // THEN
      expect(result.isOk()).toBe(false);
      expect(result.isError()).toBe(true);
      if (result.isError()) {
        expect(result.error).toBe("error message");
      }
    });

    it("should not map Error values", () => {
      // GIVEN
      const result = Result.Error("error");

      // WHEN
      const mapped = result.map((x: number) => x * 2);

      // THEN
      expect(mapped).toEqual(Result.Error("error"));
    });

    it("should not flatMap Error values", () => {
      // GIVEN
      const result = Result.Error("error");

      // WHEN
      const flatMapped = result.flatMap((x: number) => Result.Ok(x * 2));

      // THEN
      expect(flatMapped).toEqual(Result.Error("error"));
    });

    it("should mapError on Error values", () => {
      // GIVEN
      const result = Result.Error("error");

      // WHEN
      const mapped = result.mapError((e) => `Wrapped: ${e}`);

      // THEN
      expect(mapped).toEqual(Result.Error("Wrapped: error"));
    });

    it("should match Error values", () => {
      // GIVEN
      const result = Result.Error("error");

      // WHEN
      const value = result.match({
        Ok: (value: number) => value * 2,
        Error: () => 0,
      });

      // THEN
      expect(value).toBe(0);
    });

    it("should getOr return default value", () => {
      // GIVEN
      const result: Result<number, string> = Result.Error("error");

      // WHEN
      const value = result.getOr(42);

      // THEN
      expect(value).toBe(42);
    });
  });

  describe("Result namespace", () => {
    it("should create Ok from Result.Ok", () => {
      // GIVEN
      const result = Result.Ok(42);

      // WHEN
      const isOk = result.isOk();

      // THEN
      expect(isOk).toBe(true);
    });

    it("should create Error from Result.Error", () => {
      // GIVEN
      const result = Result.Error("error");

      // WHEN
      const isError = result.isError();

      // THEN
      expect(isError).toBe(true);
    });

    it("should check isOk (Ok)", () => {
      // GIVEN
      const okResult = Result.Ok(42);

      // WHEN
      const value = Result.isOk(okResult);

      // THEN
      expect(value).toBe(true);
    });

    it("should check isOk (Error)", () => {
      // GIVEN
      const errorResult = Result.Error("error");

      // WHEN
      const value = Result.isOk(errorResult);

      // THEN
      expect(value).toBe(false);
    });

    it("should check isError (Ok)", () => {
      // GIVEN
      const okResult = Result.Ok(42);

      // WHEN
      const value = Result.isError(okResult);

      // THEN
      expect(value).toBe(false);
    });

    it("should check isError (Error)", () => {
      // GIVEN
      const errorResult = Result.Error("error");

      // WHEN
      const value = Result.isError(errorResult);

      // THEN
      expect(value).toBe(true);
    });

    it("should create Result from execution (Ok)", () => {
      // GIVEN

      // WHEN
      const successResult = Result.fromExecution(() => 42);

      // THEN
      expect(successResult).toEqual(Result.Ok(42));
    });

    it("should create Result from execution (Error)", () => {
      // GIVEN

      // WHEN
      const errorResult = Result.fromExecution(() => {
        throw new Error("test error");
      });

      // THEN
      expect(errorResult).toEqual(Result.Error(new Error("test error")));
    });

    it("should combine all Ok results", () => {
      // GIVEN
      const results = [Result.Ok(1), Result.Ok(2), Result.Ok(3)];

      // WHEN
      const combined = Result.all(results);

      // THEN
      expect(combined).toEqual(Result.Ok([1, 2, 3]));
    });

    it("should fail on first Error in all", () => {
      // GIVEN
      const results = [Result.Ok(1), Result.Error("error"), Result.Ok(3)];

      // WHEN
      const combined = Result.all(results);

      // THEN
      expect(combined).toEqual(Result.Error("error"));
    });

    it("should create Ok Result from async execution that resolves", async () => {
      // GIVEN

      // WHEN
      const result = await Result.fromAsyncExecution(async () => 42);

      // THEN
      expect(result).toEqual(Result.Ok(42));
    });

    it("should create Error Result from async execution that throws", async () => {
      // GIVEN

      // WHEN
      const result = await Result.fromAsyncExecution(async () => {
        throw new Error("async error");
      });

      // THEN
      expect(result).toEqual(Result.Error(new Error("async error")));
    });

    it("should infer correct type from async execution", async () => {
      // GIVEN

      // WHEN
      const result = await Result.fromAsyncExecution(async () => "hello");

      // THEN
      expect(result.isOk()).toBe(true);
      if (result.isOk()) {
        // TypeScript should know result.value is string
        const value: string = result.value;
        expect(value).toBe("hello");
      }
    });
  });

  describe("tap", () => {
    it("invokes the callback with the Ok value and returns the same Result", () => {
      const result = Result.Ok(42);
      let observed: number | null = null;
      const returned = result.tap((v) => {
        observed = v;
      });

      expect(observed).toBe(42);
      expect(returned).toBe(result);
    });

    it("is a no-op on Err and returns the same Result", () => {
      const result: Result<number, string> = Result.Error("oops");
      let observed = false;
      const returned = result.tap(() => {
        observed = true;
      });

      expect(observed).toBe(false);
      expect(returned).toBe(result);
    });
  });

  describe("tapError", () => {
    it("invokes the callback with the Err value and returns the same Result", () => {
      const result: Result<number, string> = Result.Error("boom");
      let observed: string | null = null;
      const returned = result.tapError((e) => {
        observed = e;
      });

      expect(observed).toBe("boom");
      expect(returned).toBe(result);
    });

    it("is a no-op on Ok and returns the same Result", () => {
      const result = Result.Ok(42);
      let observed = false;
      const returned = result.tapError(() => {
        observed = true;
      });

      expect(observed).toBe(false);
      expect(returned).toBe(result);
    });
  });

  describe("flatMapError", () => {
    it("chains on Err — fn's Result replaces the original", () => {
      const result: Result<number, string> = Result.Error("retryable");
      const recovered = result.flatMapError((e) =>
        e === "retryable" ? Result.Ok(0) : Result.Error(e),
      );
      expect(recovered).toEqual(Result.Ok(0));
    });

    it("can transform the Err type", () => {
      class DomainError extends Error {}
      const result: Result<number, string> = Result.Error("raw");
      const transformed = result.flatMapError((e) => Result.Error(new DomainError(e)));

      expect(transformed.isError()).toBe(true);
      if (transformed.isError()) {
        expect(transformed.error).toBeInstanceOf(DomainError);
      }
    });

    it("passes Ok through unchanged", () => {
      const result = Result.Ok(42);
      const passed = result.flatMapError(() => Result.Ok(0));
      expect(passed).toEqual(Result.Ok(42));
    });
  });

  describe("Result.allFromDict", () => {
    it("combines all-Ok records into one Ok of a record", () => {
      const combined = Result.allFromDict({
        a: Result.Ok(1),
        b: Result.Ok("two"),
        c: Result.Ok(true),
      });

      expect(combined.isOk()).toBe(true);
      if (combined.isOk()) {
        expect(combined.value).toEqual({ a: 1, b: "two", c: true });
      }
    });

    it("returns the first Err encountered (insertion order)", () => {
      const combined = Result.allFromDict({
        a: Result.Ok(1),
        b: Result.Error("first"),
        c: Result.Error("second"),
      });

      expect(combined.isError()).toBe(true);
      if (combined.isError()) {
        expect(combined.error).toBe("first");
      }
    });

    it("returns Ok of an empty record for an empty dict", () => {
      const combined = Result.allFromDict({});
      expect(combined.isOk()).toBe(true);
      if (combined.isOk()) {
        expect(combined.value).toEqual({});
      }
    });

    it("preserves heterogeneous Ok value types via TypeScript inference", () => {
      // Type-level smoke test: each key keeps its own Ok type.
      const combined = Result.allFromDict({
        n: Result.Ok(1),
        s: Result.Ok("two"),
      });
      if (combined.isOk()) {
        const n: number = combined.value.n;
        const s: string = combined.value.s;
        expect(n).toBe(1);
        expect(s).toBe("two");
      }
    });
  });
});
