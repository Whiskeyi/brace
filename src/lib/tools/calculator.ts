import { z } from "zod";

import type { AgentTool } from "./types";

const calculatorInputSchema = z
  .object({
    expression: z.string().min(1),
    variables: z.record(z.string(), z.number().finite()).optional(),
  })
  .strict();

export type CalculatorInput = z.infer<typeof calculatorInputSchema>;

export interface CalculatorResult {
  readonly expression: string;
  readonly value: number;
}

export interface CalculatorToolOptions {
  readonly maxExpressionLength?: number;
}

type NumericFunction = (...args: number[]) => number;

const FUNCTIONS: Readonly<Record<string, NumericFunction>> = Object.freeze({
  abs: Math.abs,
  acos: Math.acos,
  asin: Math.asin,
  atan: Math.atan,
  atan2: Math.atan2,
  ceil: Math.ceil,
  cos: Math.cos,
  exp: Math.exp,
  floor: Math.floor,
  hypot: Math.hypot,
  log: Math.log,
  log10: Math.log10,
  max: Math.max,
  min: Math.min,
  pow: Math.pow,
  round: Math.round,
  sign: Math.sign,
  sin: Math.sin,
  sqrt: Math.sqrt,
  tan: Math.tan,
  trunc: Math.trunc,
});

const CONSTANTS: Readonly<Record<string, number>> = Object.freeze({
  E: Math.E,
  PI: Math.PI,
});

export function createCalculatorTool(
  options: CalculatorToolOptions = {},
): AgentTool<CalculatorInput, CalculatorResult> {
  const maxExpressionLength = options.maxExpressionLength ?? 500;
  if (!Number.isSafeInteger(maxExpressionLength) || maxExpressionLength < 1) {
    throw new Error("maxExpressionLength must be a positive safe integer.");
  }

  return {
    name: "calculator",
    description:
      "Safely evaluate a numeric expression. Supports arithmetic, parentheses, named numeric variables, and common math functions.",
    schema: calculatorInputSchema,
    annotations: { effect: "read", idempotent: true },
    execute(input) {
      if (input.expression.length > maxExpressionLength) {
        throw new Error(
          `Expression exceeds the ${maxExpressionLength}-character limit.`,
        );
      }

      const variables = input.variables ?? {};
      const value = new ArithmeticParser(input.expression, variables).parse();
      if (!Number.isFinite(value)) {
        throw new Error("Expression must evaluate to a finite number.");
      }

      return { expression: input.expression, value };
    },
  };
}

/** A deliberately small numeric grammar. It never executes JavaScript. */
class ArithmeticParser {
  readonly #source: string;
  readonly #variables: Readonly<Record<string, number>>;
  #position = 0;
  #operations = 0;
  #depth = 0;

  constructor(source: string, variables: Readonly<Record<string, number>>) {
    this.#source = source;
    this.#variables = variables;
  }

  parse(): number {
    const value = this.#parseAdditive();
    this.#skipWhitespace();
    if (this.#position !== this.#source.length) {
      throw new Error(`Unexpected token at position ${this.#position}.`);
    }
    return value;
  }

  #parseAdditive(): number {
    let value = this.#parseMultiplicative();
    while (true) {
      if (this.#consume("+")) value += this.#parseMultiplicative();
      else if (this.#consume("-")) value -= this.#parseMultiplicative();
      else return value;
      this.#countOperation();
    }
  }

  #parseMultiplicative(): number {
    let value = this.#parseUnary();
    while (true) {
      if (this.#consume("*")) value *= this.#parseUnary();
      else if (this.#consume("/")) value /= this.#parseUnary();
      else if (this.#consume("%")) value %= this.#parseUnary();
      else return value;
      this.#countOperation();
    }
  }

  #parseUnary(): number {
    if (this.#consume("+")) return this.#parseUnary();
    if (this.#consume("-")) return -this.#parseUnary();
    return this.#parsePower();
  }

  #parsePower(): number {
    const base = this.#parsePrimary();
    if (!this.#consume("^")) return base;
    this.#countOperation();
    return Math.pow(base, this.#parseUnary());
  }

  #parsePrimary(): number {
    this.#skipWhitespace();
    const number = this.#readNumber();
    if (number !== undefined) return number;

    const identifier = this.#readIdentifier();
    if (identifier) {
      if (this.#consume("(")) return this.#callFunction(identifier);
      if (Object.hasOwn(CONSTANTS, identifier)) return CONSTANTS[identifier];
      if (Object.hasOwn(this.#variables, identifier)) return this.#variables[identifier];
      throw new Error(`Unknown variable or function: ${identifier}.`);
    }

    if (this.#consume("(")) {
      this.#enterDepth();
      try {
        const value = this.#parseAdditive();
        this.#expect(")");
        return value;
      } finally {
        this.#depth -= 1;
      }
    }
    throw new Error(`Expected a number, variable, or '(' at position ${this.#position}.`);
  }

  #callFunction(name: string): number {
    if (!Object.hasOwn(FUNCTIONS, name)) {
      throw new Error(`Unknown function: ${name}.`);
    }
    this.#enterDepth();
    try {
      const args: number[] = [];
      if (!this.#consume(")")) {
        do {
          args.push(this.#parseAdditive());
          if (args.length > 32) throw new Error("Too many function arguments.");
        } while (this.#consume(","));
        this.#expect(")");
      }
      this.#countOperation();
      return FUNCTIONS[name](...args);
    } finally {
      this.#depth -= 1;
    }
  }

  #readNumber(): number | undefined {
    const match = /^(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?/.exec(
      this.#source.slice(this.#position),
    );
    if (!match) return undefined;
    this.#position += match[0].length;
    const value = Number(match[0]);
    if (!Number.isFinite(value)) throw new Error("Numeric literal is not finite.");
    return value;
  }

  #readIdentifier(): string | undefined {
    const match = /^[A-Za-z_][A-Za-z0-9_]*/.exec(
      this.#source.slice(this.#position),
    );
    if (!match) return undefined;
    this.#position += match[0].length;
    return match[0];
  }

  #consume(token: string): boolean {
    this.#skipWhitespace();
    if (!this.#source.startsWith(token, this.#position)) return false;
    this.#position += token.length;
    return true;
  }

  #expect(token: string): void {
    if (!this.#consume(token)) {
      throw new Error(`Expected '${token}' at position ${this.#position}.`);
    }
  }

  #skipWhitespace(): void {
    while (/\s/.test(this.#source[this.#position] ?? "")) this.#position += 1;
  }

  #enterDepth(): void {
    this.#depth += 1;
    if (this.#depth > 64) throw new Error("Expression nesting is too deep.");
  }

  #countOperation(): void {
    this.#operations += 1;
    if (this.#operations > 1_000) throw new Error("Expression is too complex.");
  }
}
