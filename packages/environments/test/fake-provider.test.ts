import { describe } from "vitest";
import { createFakeProvider } from "../src/fake-provider.ts";
import { providerContract } from "./provider-contract.ts";

describe("the fake provider keeps the provider contract", () => {
	providerContract(() => ({ provider: createFakeProvider() }));
});
