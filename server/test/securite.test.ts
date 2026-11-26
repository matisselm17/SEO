/**
 * Blocage des adresses internes : par le nom, par l'adresse IP, après résolution DNS et après redirection.
 */
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { isInternalHostname, isPrivateIp } from "../src/net/address.ts";
import { __setTrustedHostsForTests, assertFetchable, FetchError, guardedLookup, safeFetch, setAllowPrivateHosts } from "../src/net/fetch.ts";
import { startFixtureSite } from "./helpers/fixture-site.ts";

after(() => {
  __setTrustedHostsForTests([]);
  setAllowPrivateHosts(false);
});

test("adresses IP privées et réservées", () => {
  for (const ip of ["127.0.0.1", "10.1.2.3", "172.16.0.1", "172.31.255.255", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "224.0.0.1", "255.255.255.255", "::1", "::", "fe80::1", "fc00::1", "fd12:3456::1", "::ffff:127.0.0.1", "::ffff:10.0.0.1", "64:ff9b::7f00:1", "2001:db8::1"]) {
    assert.equal(isPrivateIp(ip), true, ip);
  }
  for (const ip of ["8.8.8.8", "1.1.1.1", "172.32.0.1", "93.184.216.34", "2606:4700:4700::1111", "::ffff:8.8.8.8"]) {
    assert.equal(isPrivateIp(ip), false, ip);
  }
});

test("noms d'hôte internes", () => {
  for (const h of ["localhost", "LOCALHOST.", "app.localhost", "printer.local", "db.internal", "intranet", "127.0.0.1", "[::1]", "2130706433", "0x7f.1", "10.0.0.1"]) {
    assert.equal(isInternalHostname(h), true, h);
  }
  for (const h of ["monsite.fr", "www.example.com", "8.8.8.8"]) assert.equal(isInternalHostname(h), false, h);
});

test("assertFetchable refuse les adresses internes et les protocoles non web", () => {
  setAllowPrivateHosts(false);
  const blocked = (u: string, kind: string) => assert.throws(() => assertFetchable(u), (e: unknown) => e instanceof FetchError && e.kind === kind, u);
  blocked("http://localhost:8787/api/sites", "blocked");
  blocked("http://127.0.0.1/", "blocked");
  blocked("http://[::1]/", "blocked");
  blocked("http://169.254.169.254/latest/meta-data/", "blocked");
  blocked("http://192.168.0.10/admin", "blocked");
  blocked("file:///etc/passwd", "invalid");
  blocked("gopher://example.com/", "invalid");
  assert.equal(assertFetchable("https://example.com/").hostname, "example.com");
});

test("la résolution DNS refuse un nom qui pointe vers une adresse interne", async () => {
  setAllowPrivateHosts(false);
  const err = await new Promise<NodeJS.ErrnoException | null>((resolve) => guardedLookup("localhost", {}, (e) => resolve(e)));
  assert.equal(err?.code, "EPRIVATEADDR");
});

test("safeFetch refuse localhost, et une redirection vers une adresse interne", async () => {
  setAllowPrivateHosts(false);
  const site = await startFixtureSite();
  try {
    await assert.rejects(safeFetch(site.origin + "/"), (e: unknown) => e instanceof FetchError && e.kind === "blocked");
    // On traite « localhost » comme public pour ce test : la redirection vers 127.0.0.1 doit être bloquée.
    __setTrustedHostsForTests(["localhost"]);
    const ok = await safeFetch(site.origin + "/old");
    assert.equal(ok.status, 200);
    assert.equal(new URL(ok.url).pathname, "/services");
    await assert.rejects(safeFetch(site.origin + "/to-internal"), (e: unknown) => e instanceof FetchError && e.kind === "blocked");
  } finally {
    __setTrustedHostsForTests([]);
    await site.close();
  }
});

test("safeFetch : taille maximale et délai d'expiration", async () => {
  setAllowPrivateHosts(true);
  const site = await startFixtureSite();
  const slow = await startFixtureSite(0, { slowMs: 1500 });
  try {
    await assert.rejects(safeFetch(site.origin + "/", { maxBytes: 100 }), (e: unknown) => e instanceof FetchError && e.kind === "too_large");
    await assert.rejects(safeFetch(slow.origin + "/", { timeoutMs: 300 }), (e: unknown) => e instanceof FetchError && e.kind === "timeout");
  } finally {
    setAllowPrivateHosts(false);
    await site.close();
    await slow.close();
  }
});
