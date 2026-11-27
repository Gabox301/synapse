import { assert, assertEquals } from "jsr:@std/assert";
import * as Y from "yjs";
import { Awareness, applyAwarenessUpdate, encodeAwarenessUpdate } from "y-protocols/awareness";
import {
  frameAwareness,
  handleAwarenessFrame,
  identityFor,
  releaseConnection,
  releaseDocument,
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
