import { assert, assertEquals } from "jsr:@std/assert";
import { Metrics } from "./metrics.ts";

Deno.test("contadores por etiqueta y render Prometheus", () => {
  const m = new Metrics();
  m.inc("synapse_messages_in_total", { kind: "update" });
  m.inc("synapse_messages_in_total", { kind: "update" });
  m.inc("synapse_messages_in_total", { kind: "sync_step1" });
  assertEquals(m.get("synapse_messages_in_total", { kind: "update" }), 2);
  assertEquals(m.get("synapse_messages_in_total", { kind: "sync_step1" }), 1);
  assertEquals(m.get("synapse_messages_in_total", { kind: "otro" }), 0);
  const text = m.render();
  assert(text.includes("# HELP synapse_messages_in_total"));
  assert(text.includes("# TYPE synapse_messages_in_total counter."));
  assert(text.includes('synapse_messages_in_total{kind="update"} 2'));
});

Deno.test("gauges y observe generan series válidas", () => {
  const m = new Metrics();
  m.set("synapse_ws_connections", 3);
  m.observe("synapse_persist_seconds", 0.05);
  m.observe("synapse_persist_seconds", 0.15);
  const text = m.render();
  assert(text.includes("synapse_ws_connections 3"));
  assert(text.includes("synapse_persist_seconds_sum 0.2"));
  assert(text.includes("synapse_persist_seconds_count 2"));
  m.reset();
  assertEquals(m.get("synapse_messages_in_total"), 0);
  assert(!m.render().includes("synapse_ws_connections 3"));
});
