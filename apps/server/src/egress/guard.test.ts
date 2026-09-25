// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

import { describe, expect, it } from "vitest";
import {
  createEgressGuard,
  parseCidr,
  PRIVATE_RANGES,
  type EgressGuard,
  type EgressPolicy,
} from "./guard.js";

// The shipped default, as server.ts assembles it for the compose stack: nothing configured, the
// deployment's own services named, and the container's own address known.
const DEPLOYMENT: EgressPolicy = {
  deny: [],
  allow: [],
  selfHosts: ["schrodump", "db", "docker-proxy", "scratch-init", "backup.example.com"],
  selfAddresses: ["172.18.0.4"],
};

// A resolver that answers from a table. Anything not in it is NXDOMAIN, which is what a typo is.
function resolving(table: Record<string, string[]>) {
  return {
    resolve: (host: string) => {
      const found = table[host];
      if (found === undefined) return Promise.reject(new Error("ENOTFOUND"));
      return Promise.resolve(found);
    },
  };
}

const DNS = resolving({
  "db": ["172.18.0.3"],
  "docker-proxy": ["172.18.0.2"],
  "schrodump": ["172.18.0.4"],
  "scratch-init": ["172.18.0.5"],
  "backup.example.com": ["203.0.113.10"],
  // The classic bypass: a name an operator controls, pointed wherever they like.
  "evil.example.com": ["127.0.0.1"],
  "metadata.example.com": ["169.254.169.254"],
  "minio.internal": ["10.4.0.9"],
  "hooks.example": ["203.0.113.50"],
  "smoke-minio": ["172.20.0.8"],
});

function guardFor(over: Partial<EgressPolicy> = {}): EgressGuard {
  return createEgressGuard({ ...DEPLOYMENT, ...over }, DNS);
}

describe("parseCidr", () => {
  it("accepts a prefix, a bare address and both families, and refuses the rest", () => {
    expect(parseCidr("10.0.0.0/8")?.prefix).toBe(8);
    // A bare address is the single host: /32 or /128, so an operator can list one without
    // remembering which suffix the family wants.
    expect(parseCidr("169.254.169.254")?.prefix).toBe(32);
    expect(parseCidr("fc00::/7")?.prefix).toBe(7);
    expect(parseCidr("::1")?.prefix).toBe(128);
    for (const bad of ["", "not-an-address", "10.0.0.0/33", "10.0.0.0/-1", "::1/129", "10.0.0.0/x"]) {
      expect(parseCidr(bad), bad).toBeNull();
    }
  });
});

describe("what the default policy refuses", () => {
  // The table the finding asked for. Every row is an address that can only be this deployment or
  // its host, and none of them is a database anybody backs up.
  const REFUSED: readonly [string, number, RegExp][] = [
    ["127.0.0.1", 5432, /loopback/],
    ["127.1.2.3", 8080, /loopback/],
    ["::1", 8080, /loopback/],
    ["[::1]", 8080, /loopback/],
    // The IPv4-mapped spelling of loopback. Byte comparison is what catches it; text matching
    // against "127." does not.
    ["::ffff:127.0.0.1", 8080, /loopback/],
    ["::ffff:7f00:1", 8080, /loopback/],
    ["169.254.169.254", 80, /metadata/],
    ["169.254.0.1", 80, /link-local/],
    ["fe80::1", 80, /link-local/],
    ["fe80::1%eth0", 80, /link-local/],
    ["0.0.0.0", 8080, /not a routable destination/],
    ["::", 8080, /not a routable destination/],
    // By name: the compose aliases, whatever port is asked for.
    ["db", 5432, /own services/],
    ["db", 9999, /own services/],
    ["DB", 5432, /own services/],
    ["docker-proxy", 2375, /own services/],
    ["schrodump", 8080, /own services/],
    // Derived from SCHRODUMP_URL: the API's own public name is still the API.
    ["backup.example.com", 443, /own services/],
    // By address, after resolution — the bypass a name-only block leaves open.
    ["172.18.0.3", 5432, /own infrastructure/],
    ["172.18.0.2", 2375, /own infrastructure/],
    // This process's own bound address, which is how "the API's own port" is reached from inside
    // the bridge network rather than over loopback.
    ["172.18.0.4", 8080, /own infrastructure/],
    // A name that resolves somewhere it should not. The refusal says it RESOLVES to it, because
    // the operator is looking at a name and needs to know why it was judged.
    ["evil.example.com", 443, /resolves to an address that is a loopback/],
    ["metadata.example.com", 80, /resolves to an address that is a link-local/],
  ];

  for (const [host, port, expected] of REFUSED) {
    it(`refuses ${host}:${String(port)}`, async () => {
      const reason = await guardFor().check(host, port);
      expect(reason, `${host} was allowed`).toMatch(expected);
      // Every refusal says how to overrule it. Without that an operator reads it as a defect.
      expect(reason).toContain("SCHRODUMP_EGRESS_ALLOW");
    });
  }
});

describe("what the default policy allows, because self-hosting means private addresses", () => {
  // The whole reason the default is narrow. A database on 10.0.0.5 and a MinIO on 192.168.1.10 are
  // the normal shape of a Schrodump deployment; refusing them out of the box would break more
  // installations than it protected.
  const ALLOWED: readonly [string, number][] = [
    ["10.0.0.5", 5432],
    ["172.16.4.4", 3306],
    ["192.168.1.10", 9000],
    ["fd00::5", 5432],
    ["203.0.113.7", 443],
    ["minio.internal", 9000],
    ["hooks.example", 443],
    // The compose smoke's own shape: container names on the project's bridge network.
    ["smoke-minio", 9000],
    // A sibling address on the same bridge as `db` — close to the deployment, but not it.
    ["172.18.0.9", 5432],
  ];

  for (const [host, port] of ALLOWED) {
    it(`allows ${host}:${String(port)}`, async () => {
      expect(await guardFor().check(host, port)).toBeNull();
    });
  }

  it("lets a name nothing can resolve through, so a typo still reports itself as unreachable", async () => {
    // There is no address to pivot to, so there is nothing to refuse — and turning NXDOMAIN into a
    // policy refusal would send the operator looking at their deny list instead of their spelling.
    expect(await guardFor().check("typo.example", 5432)).toBeNull();
  });
});

describe("SCHRODUMP_EGRESS_DENY tightens it", () => {
  it("shuts the private ranges when a deployment asks for it, and names the entry that did", async () => {
    const guard = guardFor({ deny: [...PRIVATE_RANGES] });
    expect(await guard.check("10.0.0.5", 5432)).toMatch(/inside 10\.0\.0\.0\/8/);
    expect(await guard.check("192.168.1.10", 9000)).toMatch(/inside 192\.168\.0\.0\/16/);
    expect(await guard.check("fd00::5", 5432)).toMatch(/inside fc00::\/7/);
    // Public addresses are untouched by it.
    expect(await guard.check("203.0.113.7", 443)).toBeNull();
  });

  it("applies to a NAME that resolves into a denied range, not only to a typed address", async () => {
    const guard = guardFor({ deny: ["10.0.0.0/8"] });
    expect(await guard.check("minio.internal", 9000)).toMatch(/inside 10\.0\.0\.0\/8/);
  });
});

describe("SCHRODUMP_EGRESS_ALLOW is the override, and it wins", () => {
  it("re-opens an address the built-in rules refuse", async () => {
    // Loopback is refused by default; an operator who runs a database in the same network
    // namespace can say so, and nothing else about the policy changes.
    const guard = guardFor({ allow: ["127.0.0.1/32"] });
    expect(await guard.check("127.0.0.1", 5432)).toBeNull();
    expect(await guard.check("127.0.0.2", 5432)).toMatch(/loopback/);
  });

  it("re-opens one of the deployment's own services, which is the case the self rule gets wrong", async () => {
    // A deployment whose metadata postgres also holds a database somebody backs up. Without this
    // the name rule would make that target impossible to create.
    const guard = guardFor({ allow: ["172.18.0.3/32"] });
    expect(await guard.check("db", 5432)).toBeNull();
    expect(await guard.check("172.18.0.3", 5432)).toBeNull();
    // The other service is untouched.
    expect(await guard.check("docker-proxy", 2375)).toMatch(/own/);
  });

  it("wins over an explicit deny entry as well", async () => {
    const guard = guardFor({ deny: ["10.0.0.0/8"], allow: ["10.4.0.9/32"] });
    expect(await guard.check("minio.internal", 9000)).toBeNull();
    expect(await guard.check("10.4.0.10", 9000)).toMatch(/inside 10\.0\.0\.0\/8/);
  });
});

describe("checkUrl", () => {
  it("reads the host and the scheme's default port out of the URL", async () => {
    expect(await guardFor().checkUrl("https://hooks.example/schrodump")).toBeNull();
    expect(await guardFor().checkUrl("http://127.0.0.1/hook")).toMatch(/loopback/);
    expect(await guardFor().checkUrl("http://docker-proxy:2375/containers/prune")).toMatch(/own services/);
    expect(await guardFor().checkUrl("http://[::1]:8080/hook")).toMatch(/loopback/);
  });

  it("refuses a scheme that is not http(s), which z.url() accepts and nothing here speaks", async () => {
    // `new URL()` is happy with file:// and gopher://; the channel row would store one and the
    // refusal would only arrive at delivery, as a fetch error nobody can read.
    expect(await guardFor().checkUrl("file:///etc/passwd")).toMatch(/must be http:\/\/ or https:\/\//);
    expect(await guardFor().checkUrl("not a url at all")).toMatch(/is not a URL/);
  });
});

describe("assert", () => {
  it("throws an EgressRefusedError carrying the field, so a route can name it", async () => {
    await expect(guardFor().assert("host", "127.0.0.1", 5432)).rejects.toMatchObject({
      name: "EgressRefusedError",
      field: "host",
    });
    await expect(guardFor().assertUrl("url", "http://db:5432/")).rejects.toMatchObject({
      name: "EgressRefusedError",
      field: "url",
    });
    await expect(guardFor().assert("host", "10.0.0.5", 5432)).resolves.toBeUndefined();
  });
});
