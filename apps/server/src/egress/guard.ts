// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 ARIERRAC DESENVOLVIMENTO DE SOFTWARE E SUPORTE LTDA

// The one gate every outbound connection to an operator-supplied address goes through.
//
// Four fields in this API name an address the server then dials: a webhook channel's `url`, a
// destination's S3 `endpoint`, an SMTP channel's `smtpHost`, and a database target's `host`. Each
// of them reports back whether the address answered — the webhook's HTTP status through
// `lastFailure`, the canary's `failedOperation`, the probe's `ProbeFailureCode` and `driverCode`.
// That is a port scanner with a credential form in front of it, and the interesting side of the
// scan is not the internet: this process sits on the `internal` network beside the metadata
// database (`db:5432`) and the Docker socket proxy (`docker-proxy:2375`). An `operator` — a role
// that is explicitly not meant to reach the host or the metadata database — could point a channel
// at `docker-proxy:2375`, press "send a test", and read the reflected status. The webhook path is a
// POST, and the proxy's CONTAINERS/IMAGES/NETWORKS + POST permissions accept Docker's body-less
// prune endpoints, so the same button is a denial-of-service primitive. It cannot forge a container
// create — the body is the fixed notification JSON — but nothing about that is a guarantee worth
// resting on.
//
// **What this refuses by default is deliberately narrow, and the narrowness is the decision.**
// Schrodump is self-hosted: a database target on `10.0.0.5` and a MinIO on `192.168.1.10` are the
// NORMAL case for this product, not the attack. A guard that blocked RFC-1918 out of the box would
// break more real deployments than it protected, and would be switched off by the first operator it
// inconvenienced. So the default denies only what is never a legitimate destination for a Schrodump
// connection — loopback, link-local (where the cloud metadata service lives), the unspecified
// address, and this deployment's OWN services — and leaves the operator's LAN alone. Tightening it
// to a firewall is one environment variable away (`SCHRODUMP_EGRESS_DENY`), and so is loosening it
// when the deployment's own postgres also holds a database somebody backs up
// (`SCHRODUMP_EGRESS_ALLOW`).
//
// The check is made against the RESOLVED address, not the name: `internal.example.com` with an A
// record of `127.0.0.1` is the oldest way around a name-based block. What remains is DNS rebinding
// — a name that resolves differently between this check and the socket — which is not defensible
// without owning the socket, and is written down in docs/security.md rather than pretended away.
// The webhook path, where we do own every hop, re-checks after each redirect.

import { lookup } from "node:dns/promises";
import { isIPv4, isIPv6 } from "node:net";

// An address as bytes: 4 for IPv4, 16 for IPv6. Comparing bytes rather than text is what makes
// `::ffff:7f00:1`, `::ffff:127.0.0.1` and `127.0.0.1` the same address to this file — three
// spellings a text-matching block misses two of.
export interface Cidr {
  readonly bytes: Uint8Array;
  readonly prefix: number;
  // The entry exactly as it was written, so a refusal can quote what the operator configured.
  readonly text: string;
}

function parseIpv4(text: string): Uint8Array | null {
  if (!isIPv4(text)) return null;
  const parts = text.split(".");
  const bytes = new Uint8Array(4);
  for (let index = 0; index < 4; index++) bytes[index] = Number(parts[index]);
  return bytes;
}

const HEX_WORD = /^[0-9a-fA-F]{1,4}$/;

// IPv4-mapped IPv6 (`::ffff:a.b.c.d`) is an IPv4 address wearing sixteen bytes. Returning it as
// four means one set of rules covers both spellings; leaving it as sixteen would mean every IPv4
// range in the deny list needed an `::ffff:` twin nobody would remember to add.
function unmapIpv4(bytes: Uint8Array): Uint8Array {
  for (let index = 0; index < 10; index++) if (bytes[index] !== 0) return bytes;
  if (bytes[10] !== 0xff || bytes[11] !== 0xff) return bytes;
  return bytes.slice(12);
}

function parseIpv6(text: string): Uint8Array | null {
  // A zone id (`fe80::1%eth0`) names an interface, not a different address: strip it, so a scoped
  // link-local is still recognised as link-local.
  const zone = text.indexOf("%");
  let input = zone >= 0 ? text.slice(0, zone) : text;
  if (!isIPv6(input)) return null;

  // An embedded IPv4 tail is rewritten as the two hex words it encodes, so the expansion below has
  // one shape to deal with.
  if (input.includes(".")) {
    const colon = input.lastIndexOf(":");
    const tail = parseIpv4(input.slice(colon + 1));
    if (tail === null) return null;
    const high = ((tail[0] as number) << 8) | (tail[1] as number);
    const low = ((tail[2] as number) << 8) | (tail[3] as number);
    input = `${input.slice(0, colon + 1)}${high.toString(16)}:${low.toString(16)}`;
  }

  const halves = input.split("::");
  if (halves.length > 2) return null;
  const left = halves[0] === "" ? [] : (halves[0] as string).split(":");
  const right =
    halves.length === 2 ? (halves[1] === "" ? [] : (halves[1] as string).split(":")) : [];
  if (halves.length === 1 && left.length !== 8) return null;
  if (left.length + right.length > 8) return null;

  const words = [...left, ...Array<string>(8 - left.length - right.length).fill("0"), ...right];
  const bytes = new Uint8Array(16);
  for (let index = 0; index < 8; index++) {
    const word = words[index] as string;
    if (!HEX_WORD.test(word)) return null;
    const value = Number.parseInt(word, 16);
    bytes[index * 2] = value >> 8;
    bytes[index * 2 + 1] = value & 0xff;
  }
  return unmapIpv4(bytes);
}

// An IP literal, or null when the text is a name. Brackets are stripped so the IPv6 form a URL
// hands back (`[::1]`) and the one a form field carries (`::1`) read the same.
export function parseAddress(text: string): Uint8Array | null {
  const bare = text.trim().replace(/^\[/, "").replace(/\]$/, "");
  return parseIpv4(bare) ?? parseIpv6(bare);
}

// `10.0.0.0/8`, or a bare address meaning a single host. Null when it is neither — the callers turn
// that into a boot failure naming the variable, never a silently ignored entry.
export function parseCidr(entry: string): Cidr | null {
  const text = entry.trim();
  const slash = text.lastIndexOf("/");
  const addressText = slash >= 0 ? text.slice(0, slash) : text;
  const bytes = parseAddress(addressText);
  if (bytes === null) return null;
  if (slash < 0) return { bytes, prefix: bytes.length * 8, text };
  const prefix = Number(text.slice(slash + 1));
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > bytes.length * 8) return null;
  return { bytes, prefix, text };
}

function mustParseCidr(entry: string): Cidr {
  const cidr = parseCidr(entry);
  if (cidr === null) throw new Error(`not a CIDR: ${entry}`);
  return cidr;
}

function inCidr(address: Uint8Array, cidr: Cidr): boolean {
  // An IPv4 address is never inside an IPv6 range, nor the reverse: comparing them would compare
  // four bytes against the first four of sixteen and call `10.0.0.1` a member of `0a00::/16`.
  if (address.length !== cidr.bytes.length) return false;
  let remaining = cidr.prefix;
  for (let index = 0; index < address.length && remaining > 0; index++) {
    const take = Math.min(8, remaining);
    const mask = (0xff << (8 - take)) & 0xff;
    if (((address[index] as number) & mask) !== ((cidr.bytes[index] as number) & mask)) return false;
    remaining -= take;
  }
  return true;
}

function sameAddress(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((byte, index) => byte === b[index]);
}

// Never a legitimate destination for a Schrodump connection, whatever the deployment looks like.
// Each entry carries the sentence an operator reads, because "refused by policy" is the refusal
// that produces a support thread.
const ALWAYS_DENIED: readonly { readonly cidr: Cidr; readonly why: string }[] = [
  {
    cidr: mustParseCidr("127.0.0.0/8"),
    why: "a loopback address — it can only be this container itself",
  },
  {
    cidr: mustParseCidr("::1/128"),
    why: "a loopback address — it can only be this container itself",
  },
  {
    cidr: mustParseCidr("169.254.0.0/16"),
    why: "a link-local address — 169.254.169.254 is the cloud instance metadata service, which hands out credentials",
  },
  { cidr: mustParseCidr("fe80::/10"), why: "a link-local address" },
  { cidr: mustParseCidr("0.0.0.0/8"), why: "not a routable destination" },
  { cidr: mustParseCidr("::/128"), why: "not a routable destination" },
];

// The private ranges this guard deliberately does NOT deny by default, named here because the
// documentation quotes them as the value to paste into SCHRODUMP_EGRESS_DENY when a deployment
// wants them shut. Nothing reads this list at runtime; it exists so the docs and the code cannot
// drift apart on what "tighten it" means.
export const PRIVATE_RANGES = ["10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "fc00::/7"] as const;

// The service names in the shipped compose.yaml. They are Docker network aliases, so they are the
// same whatever the project is called, and inside the `internal` network each one resolves to a
// piece of this deployment's own control plane.
export const COMPOSE_SERVICE_NAMES = ["schrodump", "db", "docker-proxy", "scratch-init"] as const;

export class EgressRefusedError extends Error {
  // Which field of the request carried the refused address, so a route can answer 400 naming it —
  // the "a refused request names the field it refused" contract of routes/errors.ts.
  readonly field: string;

  constructor(field: string, reason: string) {
    super(reason);
    this.name = "EgressRefusedError";
    this.field = field;
  }
}

export interface EgressGuard {
  // The sentence to show an operator, or null when the address may be dialled.
  check(host: string, port: number): Promise<string | null>;
  assert(field: string, host: string, port: number): Promise<void>;
  // Same, for a field that carries a whole URL (the webhook channel, the S3 endpoint).
  checkUrl(raw: string): Promise<string | null>;
  assertUrl(field: string, raw: string): Promise<void>;
}

export interface EgressPolicy {
  // Added to the built-in refusals. Parsed and validated at boot (env.ts).
  readonly deny: readonly string[];
  // Wins over every refusal, built-in ones included. This is the operator saying "yes, I mean that
  // address" — including for the one case the self-service rule gets wrong on purpose: a deployment
  // whose metadata postgres also holds a database somebody backs up.
  readonly allow: readonly string[];
  // Names of this deployment's own services: the compose aliases plus whatever DATABASE_URL,
  // DOCKER_HOST and SCHRODUMP_URL actually point at.
  readonly selfHosts: readonly string[];
  // Addresses this process is itself bound to. Denying them is how "the API's own port" holds even
  // when it is reached by the container's bridge address rather than by name or by loopback.
  readonly selfAddresses: readonly string[];
}

export interface EgressGuardDeps {
  // dns.lookup semantics on purpose, not dns.resolve: /etc/hosts and the container's own resolver
  // are what the socket will consult, and a guard that asked a different question than the
  // connection would be checking a different address.
  resolve(host: string): Promise<readonly string[]>;
}

const DEFAULT_DEPS: EgressGuardDeps = {
  resolve: async (host) =>
    (await lookup(host, { all: true, verbatim: true })).map((entry) => entry.address),
};

// How long a self-service name's resolution is reused. Short enough that a container restarting
// with a new bridge address stops being invisible within a minute; long enough that one form
// submission does not cost four DNS round trips.
const SELF_RESOLUTION_TTL_MS = 60_000;

function endpointOfUrl(
  raw: string,
): { readonly host: string; readonly port: number } | { readonly reason: string } {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { reason: "is not a URL" };
  }
  // z.url() accepts any scheme `new URL()` accepts, so without this a channel could be saved as
  // `file:///etc/passwd`. Nothing downstream speaks anything but HTTP, and a scheme this guard
  // cannot reduce to a host and a port is a scheme it cannot check.
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { reason: `must be http:// or https:// — "${url.protocol}//" is neither` };
  }
  const port = url.port === "" ? (url.protocol === "https:" ? 443 : 80) : Number(url.port);
  return { host: url.hostname, port };
}

export function createEgressGuard(
  policy: EgressPolicy,
  deps: EgressGuardDeps = DEFAULT_DEPS,
): EgressGuard {
  // Unparseable entries never reach here: env.ts refuses the boot naming the variable.
  const deny = policy.deny.map(parseCidr).filter((cidr): cidr is Cidr => cidr !== null);
  const allow = policy.allow.map(parseCidr).filter((cidr): cidr is Cidr => cidr !== null);
  const selfHosts = new Set(
    policy.selfHosts.map((host) => host.trim().toLowerCase()).filter((host) => host !== ""),
  );
  const selfLiterals = policy.selfAddresses
    .map(parseAddress)
    .filter((address): address is Uint8Array => address !== null);

  let selfResolved: { readonly at: number; readonly addresses: readonly Uint8Array[] } | null = null;

  // Every address the deployment's own service names currently answer with. This is what closes the
  // obvious hole in a name-based block: `db` is refused by name, and `172.18.0.3` — the address
  // `db` happens to hold this week — is refused by this.
  async function selfServiceAddresses(): Promise<readonly Uint8Array[]> {
    const now = Date.now();
    if (selfResolved !== null && now - selfResolved.at < SELF_RESOLUTION_TTL_MS) {
      return selfResolved.addresses;
    }
    const addresses: Uint8Array[] = [...selfLiterals];
    for (const host of selfHosts) {
      // A literal in selfHosts is already matched by name, byte for byte.
      if (parseAddress(host) !== null) continue;
      try {
        for (const text of await deps.resolve(host)) {
          const parsed = parseAddress(text);
          if (parsed !== null) addresses.push(parsed);
        }
      } catch {
        // A name that does not resolve is a name nothing can be reached at. Outside compose,
        // DATABASE_URL may well name a host this container cannot look up; that is not a reason to
        // refuse every connection, and the name itself is still denied below.
      }
    }
    selfResolved = { at: now, addresses };
    return addresses;
  }

  // The remedy, appended once rather than written into six sentences. A refusal that does not say
  // how to overrule it reads as a bug in the product to the operator whose 10.x MinIO it refused.
  // Only the address-based refusals carry it — pointing an operator who pasted `file:///etc/passwd`
  // at an allow-list would be advice that cannot work.
  function withRemedy(reason: string): string {
    return `${reason}. If this address really is a destination Schrodump should reach, add it to SCHRODUMP_EGRESS_ALLOW`;
  }

  async function reasonFor(host: string, port: number): Promise<string | null> {
    const name = host.trim().replace(/^\[/, "").replace(/\]$/, "").toLowerCase();
    if (name === "") return "names no host";

    const literal = parseAddress(name);
    let addresses: Uint8Array[];
    if (literal !== null) {
      addresses = [literal];
    } else {
      try {
        addresses = (await deps.resolve(name))
          .map(parseAddress)
          .filter((address): address is Uint8Array => address !== null);
      } catch {
        // A name nothing can resolve is a name nothing can connect to, so there is no pivot to
        // refuse. Letting it through keeps a typo reporting itself as UNREACHABLE — which is what
        // it is — instead of as a policy refusal, which would send the operator looking in the
        // wrong place.
        return null;
      }
    }
    if (addresses.length === 0) return null;

    // The explicit override, checked first and on purpose: an operator who listed an address in
    // SCHRODUMP_EGRESS_ALLOW has answered this question already — for the built-in refusals, and
    // for a name this guard would otherwise recognise as one of its own services.
    if (addresses.some((address) => allow.some((cidr) => inCidr(address, cidr)))) return null;

    if (selfHosts.has(name)) {
      return withRemedy(
        `"${host}" is one of this deployment's own services — Schrodump does not connect to its own control plane`,
      );
    }

    for (const address of addresses) {
      const configured = deny.find((cidr) => inCidr(address, cidr));
      if (configured !== undefined) {
        return withRemedy(`${host} is inside ${configured.text}, which SCHRODUMP_EGRESS_DENY refuses`);
      }
      const builtIn = ALWAYS_DENIED.find((entry) => inCidr(address, entry.cidr));
      if (builtIn !== undefined) {
        const lead = literal === null ? `${host} resolves to an address that is ` : `${host} is `;
        return withRemedy(`${lead}${builtIn.why}`);
      }
    }

    const own = await selfServiceAddresses();
    for (const address of addresses) {
      if (own.some((entry) => sameAddress(entry, address))) {
        return withRemedy(
          `${host}:${String(port)} is this deployment's own infrastructure — Schrodump does not connect to its own control plane`,
        );
      }
    }

    return null;
  }

  const guard: EgressGuard = {
    check: (host, port) => reasonFor(host, port),
    assert: async (field, host, port) => {
      const reason = await guard.check(host, port);
      if (reason !== null) throw new EgressRefusedError(field, reason);
    },
    checkUrl: async (raw) => {
      const endpoint = endpointOfUrl(raw);
      if ("reason" in endpoint) return `${raw} ${endpoint.reason}`;
      return guard.check(endpoint.host, endpoint.port);
    },
    assertUrl: async (field, raw) => {
      const reason = await guard.checkUrl(raw);
      if (reason !== null) throw new EgressRefusedError(field, reason);
    },
  };
  return guard;
}
