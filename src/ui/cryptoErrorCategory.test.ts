import { describe, it, expect } from "vitest";
import { categorizeCryptoError } from "./cryptoErrorCategory";

describe("categorizeCryptoError", () => {
  it("maps a WASM multi-value CompileError to 'wasm'", () => {
    expect(
      categorizeCryptoError(
        "CompileError: WebAssembly.instantiate(): Compiling function #42 failed: " +
          "return count of 2 exceeds internal limit of 1",
      ),
    ).toBe("wasm");
  });

  it("maps an IndexedDB error to 'datastore'", () => {
    expect(
      categorizeCryptoError("UnknownError: Internal error opening backing store for indexedDB.open."),
    ).toBe("datastore");
  });

  it("maps an arbitrary string to 'unknown'", () => {
    expect(categorizeCryptoError("something totally unexpected happened")).toBe("unknown");
    expect(categorizeCryptoError(undefined)).toBe("unknown");
    expect(categorizeCryptoError(null)).toBe("unknown");
  });

  it("prefers 'wasm' over 'datastore' when a message mentions both", () => {
    expect(
      categorizeCryptoError("WebAssembly CompileError while opening the crypto store database"),
    ).toBe("wasm");
  });
});
