import { describe, expect, test } from "vite-plus/test";

import { DEFAULT_DEBUG_PORT, jdwpArg } from "./debug.ts";

describe("jdwpArg", () => {
  test("binds loopback by default so JDWP isn't exposed to the network", () => {
    expect(jdwpArg({ port: 5005, suspend: false })).toBe(
      "-agentlib:jdwp=transport=dt_socket,server=y,suspend=n,address=127.0.0.1:5005",
    );
  });

  test("exposed binds all interfaces (opt-in for container/WSL2)", () => {
    expect(jdwpArg({ port: 5005, suspend: false, exposed: true })).toContain("address=*:5005");
  });

  test("suspend=y makes the JVM wait for the debugger", () => {
    expect(jdwpArg({ port: 5006, suspend: true })).toContain("suspend=y");
    expect(jdwpArg({ port: 5006, suspend: true })).toContain("address=127.0.0.1:5006");
  });

  test("default port is the 5005 IDE convention", () => {
    expect(DEFAULT_DEBUG_PORT).toBe(5005);
  });
});
