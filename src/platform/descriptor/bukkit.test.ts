/**
 * Contract tests for the Bukkit-family descriptor generator. No YAML dep:
 * a small line-splitter parses the output and JSON.parse decodes
 * double-quoted scalars for escape correctness.
 */

import { describe, expect, test } from "vite-plus/test";

import type { ResolvedProject } from "../../project.ts";

import { bukkitDescriptor } from "./bukkit.ts";

function project(overrides: Partial<ResolvedProject> = {}): ResolvedProject {
  return {
    name: "MyPlugin",
    version: "1.0.0",
    main: "com.example.MyPlugin",
    compatibility: { versions: ["1.21.8"], platforms: ["paper"] },
    rootDir: "/tmp/project",
    projectFile: "/tmp/project/project.json",
    ...overrides,
  };
}

/**
 * Parse the subset of YAML the Bukkit generator emits: `key: scalar` and
 * `key:` followed by `  - item` lines. Double-quoted scalars are decoded
 * via JSON.parse.
 */
function parseDescriptor(yaml: string): Record<string, string | string[]> {
  const result: Record<string, string | string[]> = {};
  const lines = yaml.split("\n");
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.length === 0) {
      i++;
      continue;
    }
    const colonIdx = line.indexOf(":");
    const key = line.slice(0, colonIdx);
    const rest = line.slice(colonIdx + 1).trimStart();
    if (rest.length === 0) {
      const items: string[] = [];
      i++;
      while (i < lines.length && lines[i].startsWith("  - ")) {
        items.push(decodeScalar(lines[i].slice(4)));
        i++;
      }
      result[key] = items;
    } else {
      result[key] = decodeScalar(rest);
      i++;
    }
  }
  return result;
}

function decodeScalar(token: string): string {
  if (token.startsWith('"') && token.endsWith('"')) {
    return JSON.parse(token);
  }
  return token;
}

describe("bukkitDescriptor.generate", () => {
  test("emits required fields for a minimal project", () => {
    const output = bukkitDescriptor.generate(project());
    const parsed = parseDescriptor(output);
    expect(parsed.name).toBe("MyPlugin");
    expect(parsed.version).toBe("1.0.0");
    expect(parsed.main).toBe("com.example.MyPlugin");
    expect(parsed["api-version"]).toBe("1.21");
    expect(output.endsWith("\n")).toBe(true);
    expect(output.includes("\r")).toBe(false);
  });

  test("emits all optional fields when present", () => {
    const output = bukkitDescriptor.generate(
      project({
        description: "A plugin that does things.",
        authors: ["Alice", "Bob"],
      }),
    );
    const parsed = parseDescriptor(output);
    expect(parsed.description).toBe("A plugin that does things.");
    expect(parsed.authors).toEqual(["Alice", "Bob"]);
  });

  test("omits optional fields when absent", () => {
    const output = bukkitDescriptor.generate(project());
    expect(output).not.toContain("description:");
    expect(output).not.toContain("authors:");
    expect(output).not.toContain("commands:");
  });

  test("derives depend from workspace: dependencies, ignoring other sources", () => {
    const output = bukkitDescriptor.generate(
      project({
        dependencies: {
          core: { source: "workspace:core", version: "*" },
          util: { source: "workspace:util", version: "*" },
          Vault: "1.7.3",
          adventure: { source: "maven:net.kyori:adventure-api", version: "4.24.0" },
        },
      }),
    );
    expect(output).toContain(["depend:", "  - core", "  - util"].join("\n"));
    expect(output).not.toContain("Vault");
    expect(output).not.toContain("adventure");
  });

  test("omits depend when there are no workspace dependencies", () => {
    const output = bukkitDescriptor.generate(project({ dependencies: { Vault: "1.7.3" } }));
    expect(output).not.toContain("depend:");
  });

  test("renders a commands block with only the fields that are set", () => {
    const output = bukkitDescriptor.generate(
      project({
        commands: {
          balance: { description: "Show balance", usage: "/balance", aliases: ["bal", "money"] },
          pay: { permission: "economy.pay", permissionMessage: "No permission: denied" },
        },
      }),
    );
    expect(output).toContain(
      [
        "commands:",
        "  balance:",
        "    description: Show balance",
        "    usage: /balance",
        "    aliases:",
        "      - bal",
        "      - money",
        "  pay:",
        "    permission: economy.pay",
        '    permission-message: "No permission: denied"',
      ].join("\n"),
    );
  });

  test("throws when main is missing", () => {
    expect(() => bukkitDescriptor.generate(project({ main: undefined }))).toThrow(
      "Bukkit descriptor requires project.main",
    );
  });

  test("derives api-version as major.minor", () => {
    expect(
      parseDescriptor(
        bukkitDescriptor.generate(
          project({ compatibility: { versions: ["1.21.8"], platforms: ["paper"] } }),
        ),
      )["api-version"],
    ).toBe("1.21");

    expect(
      parseDescriptor(
        bukkitDescriptor.generate(
          project({ compatibility: { versions: ["1.8"], platforms: ["paper"] } }),
        ),
      )["api-version"],
    ).toBe("1.8");
  });

  test("omits api-version when primary version is missing or malformed", () => {
    const output = bukkitDescriptor.generate(
      project({ compatibility: { versions: [], platforms: ["paper"] } }),
    );
    expect(output).not.toContain("api-version:");
  });

  test("quotes and escapes descriptions containing YAML specials", () => {
    const tricky = 'line with "quotes", a: colon, and #hash';
    const output = bukkitDescriptor.generate(project({ description: tricky }));
    const parsed = parseDescriptor(output);
    expect(parsed.description).toBe(tricky);
  });

  test("escapes backslashes so they round-trip", () => {
    const desc = "path\\to\\thing";
    const output = bukkitDescriptor.generate(project({ description: desc }));
    const parsed = parseDescriptor(output);
    expect(parsed.description).toBe(desc);
  });

  test("quotes reserved words (true / null / numeric-looking)", () => {
    const output = bukkitDescriptor.generate(project({ authors: ["true", "null", "1.0"] }));
    expect(output).toContain('- "true"');
    expect(output).toContain('- "null"');
    expect(output).toContain('- "1.0"');
    const parsed = parseDescriptor(output);
    expect(parsed.authors).toEqual(["true", "null", "1.0"]);
  });

  test("uses LF line endings only", () => {
    const output = bukkitDescriptor.generate(
      project({ authors: ["Alice", "Bob"], description: "x" }),
    );
    expect(output.split("\r\n").length).toBe(1);
  });
});
