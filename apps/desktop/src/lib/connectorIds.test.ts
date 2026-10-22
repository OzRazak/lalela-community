import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  chooseConnectorImportId,
  connectorImportIds,
  connectorProviderOf,
  legacyConnectorMeetingId,
  ownedConnectorMeetingId,
  rekeyTargetFor,
} from "./connectorIds.ts";

const sha1 = (s: string) => createHash("sha1").update(s).digest("hex");
const ALICE = "3db3788a-0000-4000-8000-000000000001";
const OZ = "9f00c0de-0000-4000-8000-000000000002";
const EXT = "MSo1N2Y5ZGFjYy03MWJmLTQ3NDMtYjQxMy01M2EzODFkOTMyYmY:VjEjIzFjMTU";

test("legacy id is the pre-#284 scheme, byte for byte", async () => {
  assert.equal(await legacyConnectorMeetingId("teams", EXT), `conn-teams-${sha1(EXT).slice(0, 16)}`);
});

test("per-owner id hashes owner + legacy id, differs per owner, is stable", async () => {
  const legacy = await legacyConnectorMeetingId("teams", EXT);
  const oz = await ownedConnectorMeetingId("teams", OZ, legacy);
  assert.equal(oz, `conn-teams-${sha1(`${OZ}:${legacy}`).slice(0, 16)}`);
  assert.notEqual(oz, await ownedConnectorMeetingId("teams", ALICE, legacy));
  assert.notEqual(oz, legacy);
  assert.equal(oz, await ownedConnectorMeetingId("teams", OZ, legacy));
  assert.match(oz, /^conn-teams-[0-9a-f]{16}$/);
});

test("connectorImportIds: no owned id while signed out", async () => {
  const out = await connectorImportIds("teams", EXT, null);
  assert.equal(out.owned, null);
  assert.equal(out.legacy, await legacyConnectorMeetingId("teams", EXT));
  const signedIn = await connectorImportIds("teams", EXT, OZ);
  assert.equal(signedIn.owned, await ownedConnectorMeetingId("teams", OZ, signedIn.legacy));
});

test("re-key target converges with a fresh per-owner import of the same meeting", async () => {
  // The whole point of hashing the legacy id: a collided meeting re-keyed from
  // its legacy id lands on the id a new import by the same owner would pick.
  const { legacy, owned } = await connectorImportIds("teams", EXT, OZ);
  assert.equal(await rekeyTargetFor(legacy, OZ), owned);
  // Oz's real collided meeting gets a stable, per-owner target.
  const real = "conn-teams-63798078569f1569";
  const target = await rekeyTargetFor(real, OZ);
  assert.equal(target, `conn-teams-${sha1(`${OZ}:${real}`).slice(0, 16)}`);
});

test("re-key applies to connector imports only, and only when signed in", async () => {
  assert.equal(await rekeyTargetFor("mtg-1700000000000", OZ), null);
  assert.equal(await rekeyTargetFor("web-abc", OZ), null);
  assert.equal(await rekeyTargetFor("connfolder-teams-3db3788a", OZ), null);
  assert.equal(await rekeyTargetFor("conn-teams-63798078569f1569", null), null);
  assert.match((await rekeyTargetFor("conn-fathom-0123456789abcdef", OZ))!, /^conn-fathom-[0-9a-f]{16}$/);
});

test("connectorProviderOf", () => {
  assert.equal(connectorProviderOf("conn-teams-63798078569f1569"), "teams");
  assert.equal(connectorProviderOf("conn-readai-0123456789abcdef"), "readai");
  assert.equal(connectorProviderOf("mtg-123"), null);
  assert.equal(connectorProviderOf("conn-teams-"), null);
  assert.equal(connectorProviderOf("connfolder-teams-abc"), null);
});

test("choose: dedupes against the LEGACY id imported before #284", async () => {
  const ids = await connectorImportIds("teams", EXT, OZ);
  const have = new Set([ids.legacy]);
  assert.deepEqual(chooseConnectorImportId({ ...ids, have, uid: OZ }), { action: "skip", reason: "local" });
});

test("choose: dedupes against the per-owner id and against re-key aliases", async () => {
  const ids = await connectorImportIds("teams", EXT, OZ);
  assert.equal(chooseConnectorImportId({ ...ids, have: new Set([ids.owned!]), uid: OZ }).action, "skip");
  // After a re-key the legacy id lives on only as an alias — still a skip.
  const aliases = new Set(["conn-teams-unrelated", ids.legacy]);
  assert.equal(chooseConnectorImportId({ ...ids, have: aliases, uid: OZ }).action, "skip");
});

test("choose: signed in → per-owner id, even when the legacy id is free", async () => {
  const ids = await connectorImportIds("teams", EXT, OZ);
  assert.deepEqual(chooseConnectorImportId({ ...ids, have: new Set(), uid: OZ }), {
    action: "import",
    id: ids.owned,
  });
  // Legacy id owned by ANOTHER account in the cloud → still the per-owner id.
  const owners = new Map([[ids.legacy, ALICE]]);
  assert.deepEqual(chooseConnectorImportId({ ...ids, have: new Set(), uid: OZ, cloudOwners: owners }), {
    action: "import",
    id: ids.owned,
  });
});

test("choose: already MINE in the cloud under either id → skip (pull-down brings it)", async () => {
  const ids = await connectorImportIds("teams", EXT, OZ);
  for (const id of [ids.legacy, ids.owned!]) {
    const owners = new Map([[id, OZ]]);
    assert.deepEqual(chooseConnectorImportId({ ...ids, have: new Set(), uid: OZ, cloudOwners: owners }), {
      action: "skip",
      reason: "cloud",
    });
  }
  // Lookup failed (null) → decide from local state alone.
  assert.equal(chooseConnectorImportId({ ...ids, have: new Set(), uid: OZ, cloudOwners: null }).action, "import");
});

test("choose: signed out → legacy id (re-keyed at first push if it collides)", async () => {
  const ids = await connectorImportIds("teams", EXT, null);
  assert.deepEqual(chooseConnectorImportId({ ...ids, have: new Set(), uid: null }), {
    action: "import",
    id: ids.legacy,
  });
  assert.equal(chooseConnectorImportId({ ...ids, have: new Set([ids.legacy]), uid: null }).action, "skip");
});
