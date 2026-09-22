import assert from "node:assert/strict";
import test from "node:test";
import { checkHostAccess, organizeDiscoveredHosts } from "./hosts.ts";
import { assertServerTarget } from "../shared/host-target.ts";

const hosts = [
  { serverId: "srv_primary", label: "Laptop", status: "online" },
  { serverId: "srv_vm", label: "Dev VM", status: "offline" },
];

function route(overrides = {}) {
  return {
    id: "route-vm",
    serverId: "srv_vm",
    label: "Dev VM",
    bridgeUrl: "https://dev-vm.example.ts.net",
    enabled: true,
    machineName: "dev-vm",
    tokenPreview: "abcd…wxyz",
    ...overrides,
  };
}

test("multi-host discovery keeps offline hosts and identifies the surface host", () => {
  const model = organizeDiscoveredHosts(hosts, "srv_primary", [route()]);
  assert.deepEqual(
    model.hosts.map(({ serverId, status, isSurfaceHost, route: matched }) => ({
      serverId,
      status,
      isSurfaceHost,
      routeId: matched?.id ?? null,
    })),
    [
      { serverId: "srv_primary", status: "online", isSurfaceHost: true, routeId: null },
      { serverId: "srv_vm", status: "offline", isSurfaceHost: false, routeId: "route-vm" },
    ],
  );
  assert.deepEqual(model.undiscoveredRoutes, []);
});

test("routes match only an exact serverId and never a reused label", () => {
  const wrongIdentity = route({ serverId: "srv_old", label: "Dev VM" });
  const model = organizeDiscoveredHosts(hosts, "srv_primary", [wrongIdentity]);
  assert.equal(model.hosts[1].route, null);
  assert.deepEqual(model.undiscoveredRoutes, [wrongIdentity]);
});

test("legacy routes without a serverId remain visible only as compatibility routes", () => {
  const legacy = route({ serverId: null });
  const model = organizeDiscoveredHosts(hosts, "srv_primary", [legacy]);
  assert.equal(model.hosts.every((host) => host.route === null), true);
  assert.deepEqual(model.undiscoveredRoutes, [legacy]);
});

test("host access passes the exact serverId to the targeted client", async () => {
  const requested = [];
  const count = await checkHostAccess("srv_vm", (serverId) => {
    requested.push(serverId);
    return { projects: { list: async () => ({ projects: [{ id: "a" }, { id: "b" }] }) } };
  });
  assert.equal(count, 2);
  assert.deepEqual(requested, ["srv_vm"]);
});

test("unknown and disconnected target errors escape without a selected-host fallback", async () => {
  const requested = [];
  await assert.rejects(
    checkHostAccess("missing", (serverId) => {
      requested.push(serverId);
      throw new Error("Unknown Paseo host: missing");
    }),
    /Unknown Paseo host: missing/,
  );
  await assert.rejects(
    checkHostAccess("srv_vm", (serverId) => {
      requested.push(serverId);
      throw new Error("Paseo host is disconnected: srv_vm");
    }),
    /Paseo host is disconnected: srv_vm/,
  );
  assert.deepEqual(requested, ["missing", "srv_vm"]);
});

test("each action reacquires its host client after connection replacement", async () => {
  let acquisitions = 0;
  const clients = [
    { projects: { list: async () => ({ projects: [{ id: "old" }] }) } },
    { projects: { list: async () => ({ projects: [{ id: "new" }, { id: "newer" }] }) } },
  ];
  const getter = (serverId) => {
    assert.equal(serverId, "srv_vm");
    return clients[acquisitions++];
  };
  assert.equal(await checkHostAccess("srv_vm", getter), 1);
  assert.equal(await checkHostAccess("srv_vm", getter), 2);
  assert.equal(acquisitions, 2);
});

test("surface RPC targeting rejects a changed host instead of running locally", () => {
  assert.doesNotThrow(() => assertServerTarget("srv_vm", "srv_vm"));
  assert.throws(
    () => assertServerTarget("srv_vm", "srv_primary"),
    /requested srv_vm, reached srv_primary/,
  );
});
