import { assert, assertEquals } from "jsr:@std/assert";
import * as Y from "yjs";
import {
  Awareness,
  applyAwarenessUpdate,
  encodeAwarenessUpdate,
  removeAwarenessStates,
} from "y-protocols/awareness";
import {
  applyRemoteAwareness,
  frameAwareness,
  handleAwarenessFrame,
  identityFor,
  inspectAwarenessUpdate,
  releaseConnection,
  releaseDocument,
  removeRemoteStates,
} from "./awareness.ts";

function fakeConn(): WebSocket {
  return {} as unknown as WebSocket;
}

/** Frame SNP completo (0x04 + update), como llega por el wire. */
function clientFrame(user: unknown): { frame: Uint8Array; clientId: number } {
  const doc = new Y.Doc();
  const aw = new Awareness(doc);
  aw.setLocalState({ user, cursor: 0 });
  const frame = frameAwareness(encodeAwarenessUpdate(aw, [aw.clientID]));
  const id = aw.clientID;
  aw.destroy();
  return { frame, clientId: id };
}

Deno.test("awareness fija identidad del servidor y registra propiedad", () => {
  const conn = fakeConn();
  const owned = new Set<number>();
  const id = identityFor("u1", "gabo@test.local");
  assertEquals(id.name, "gabo");
  const { frame, clientId } = clientFrame({ name: "HACKER", color: "red", id: "fake" });
  const out = handleAwarenessFrame("doc-aw-1", conn, owned, frame, id);
  assertEquals(out.dropped, false);
  assert(out.relay !== null);
  // El relay lleva la identidad del servidor, no la del cliente.
  const probe = new Awareness(new Y.Doc());
  applyAwarenessUpdate(probe, out.relay!, null);
  const entry = probe.getStates().get(clientId) as unknown as { user?: { id: string; name: string; color: string } } | undefined;
  assert(entry !== undefined, "falta el estado del cliente");
  assertEquals(entry!.user, { id: "u1", name: "gabo", color: id.color });
  probe.destroy();
  releaseDocument("doc-aw-1");
});

Deno.test("spoof de clientID ajeno se descarta completo", () => {
  const a = fakeConn();
  const b = fakeConn();
  const ownedA = new Set<number>();
  const ownedB = new Set<number>();
  const idA = identityFor("uA", "a@test.local");
  const { frame: fa, clientId } = clientFrame({ name: "a" });
  const ra = handleAwarenessFrame("doc-aw-2", a, ownedA, fa, idA);
  assertEquals(ra.dropped, false);
  // B intenta suplantar el clientID de A mezclado con uno propio.
  const docB = new Y.Doc();
  const awB = new Awareness(docB);
  awB.setLocalState({ user: { name: "b" } });
  const ownFrame = encodeAwarenessUpdate(awB, [awB.clientID]);
  void ownFrame;
  awB.destroy();
  // Reenvía el frame de A tal cual (replay/spoof).
  const rb = handleAwarenessFrame("doc-aw-2", b, ownedB, fa, identityFor("uB", "b@test.local"));
  assertEquals(rb.dropped, true);
  assertEquals(rb.relay, null);
  assertEquals(ownedB.size, 0);
  void clientId;
  releaseDocument("doc-aw-2");
});

Deno.test("releaseConnection emite remoción aplicable", () => {
  const conn = fakeConn();
  const owned = new Set<number>();
  const id = identityFor("u1", "g@t.l");
  const { frame, clientId } = clientFrame({ name: "x" });
  const out = handleAwarenessFrame("doc-aw-3", conn, owned, frame, id);
  assertEquals(out.dropped, false);
  assert(owned.has(clientId));
  const removal = releaseConnection("doc-aw-3", conn);
  assert(removal !== null);
  // Aplicar la remoción elimina el estado (queda solo la auto-entrada del probe).
  const probe = new Awareness(new Y.Doc());
  applyAwarenessUpdate(probe, out.relay!, null);
  assert(probe.getStates().has(clientId), "falta el estado tras relay");
  applyAwarenessUpdate(probe, removal!, conn);
  assert(!probe.getStates().has(clientId), "no se removió");
  probe.destroy();
  // Segunda vez no hay nada que remover.
  assertEquals(releaseConnection("doc-aw-3", conn), null);
  releaseDocument("doc-aw-3");
});

Deno.test("inspectAwarenessUpdate reporta added, updated y removed", () => {
  const doc = new Y.Doc();
  const aw = new Awareness(doc);
  const clientId = aw.clientID;
  // Alta: el clientID es nuevo para el inspector.
  aw.setLocalState({ cursor: 1 });
  const added = inspectAwarenessUpdate(encodeAwarenessUpdate(aw, [clientId]));
  assertEquals(added.added, [clientId]);
  assertEquals(added.updated, []);
  assertEquals(added.removed, []);
  // Cambio de estado del mismo clientID: ya no es alta.
  aw.setLocalState({ cursor: 2 });
  const moved = inspectAwarenessUpdate(encodeAwarenessUpdate(aw, [clientId]));
  assertEquals(moved.updated, [clientId]);
  assertEquals(moved.added, []);
  // Remoción explícita (el cliente cierra o la instancia lo da de baja).
  removeAwarenessStates(aw, [clientId], "test");
  const gone = inspectAwarenessUpdate(encodeAwarenessUpdate(aw, [clientId]));
  assertEquals(gone.removed, [clientId]);
  assertEquals(gone.added, []);
  aw.destroy();
});

Deno.test("removeRemoteStates emite una remoción que limpia el estado", () => {
  // Sin entry o sin ids no hay nada que remover.
  assertEquals(removeRemoteStates("doc-aw-rem-0", [1234]), null);
  // Estado de otra instancia: llega por el bus (applyRemoteAwareness).
  const remoteDoc = new Y.Doc();
  const remoteAw = new Awareness(remoteDoc);
  const clientId = remoteAw.clientID;
  remoteAw.setLocalState({ user: { name: "remota" }, cursor: 3 });
  const update = encodeAwarenessUpdate(remoteAw, [clientId]);
  remoteAw.destroy();
  applyRemoteAwareness("doc-aw-rem-1", update);
  assertEquals(removeRemoteStates("doc-aw-rem-1", []), null);
  const removal = removeRemoteStates("doc-aw-rem-1", [clientId]);
  assert(removal !== null, "debió emitir remoción");
  // Aplicada sobre una réplica que tenía el estado, lo limpia.
  const probe = new Awareness(new Y.Doc());
  applyAwarenessUpdate(probe, update, null);
  assert(probe.getStates().has(clientId), "falta el estado remoto");
  applyAwarenessUpdate(probe, removal!, null);
  assert(!probe.getStates().has(clientId), "no se removió el estado remoto");
  probe.destroy();
  // Repetible: el reloj ya conocido permite volver a anunciar la remoción.
  assert(removeRemoteStates("doc-aw-rem-1", [clientId]) !== null);
  releaseDocument("doc-aw-rem-1");
});

Deno.test("removeRemoteStates no toca conexiones locales vivas", () => {
  const conn = fakeConn();
  const owned = new Set<number>();
  const { frame, clientId } = clientFrame({ name: "local" });
  const out = handleAwarenessFrame(
    "doc-aw-rem-2",
    conn,
    owned,
    frame,
    identityFor("u1", "x@t.l"),
  );
  assertEquals(out.dropped, false);
  // Una instancia remota no puede borrar el awareness de una conexión local.
  assertEquals(removeRemoteStates("doc-aw-rem-2", [clientId]), null);
  assert(
    releaseConnection("doc-aw-rem-2", conn) !== null,
    "el owner local debía seguir intacto",
  );
  releaseDocument("doc-aw-rem-2");
});
