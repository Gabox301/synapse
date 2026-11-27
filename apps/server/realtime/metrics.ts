// Métricas en formato Prometheus exposition (Etapa 5 T1).
// Sin dependencias; proceso-local. Para scraping externo (sin auth en v1).
export type Labels = Record<string, string>;

const HELP: Record<string, string> = {
  synapse_ws_connections: "Conexiones WebSocket activas",
  synapse_documents_active: "Documentos con estado en memoria",
  synapse_messages_in_total: "Frames entrantes por tipo",
  synapse_messages_out_total: "Mensajes salientes por tipo",
  synapse_acks_total: "document:ack enviados tras commit",
  synapse_joins_total: "document:joined enviados",
  synapse_rejections_total: "Rechazos en handshake y ruteo, por motivo",
  synapse_persist_total: "Lotes confirmados en PostgreSQL",
  synapse_persist_errors_total: "Fallos de persistencia",
  synapse_persist_seconds: "Latencia de commit de lote",
  synapse_rate_limited_total: "Mensajes descartados por rate limiting",
};

const TYPE: Record<string, string> = {
  synapse_ws_connections: "gauge",
  synapse_documents_active: "gauge",
  synapse_messages_in_total: "counter",
  synapse_messages_out_total: "counter",
  synapse_acks_total: "counter",
  synapse_joins_total: "counter",
  synapse_rejections_total: "counter",
  synapse_persist_total: "counter",
  synapse_persist_errors_total: "counter",
  synapse_persist_seconds: "summary",
  synapse_rate_limited_total: "counter",
};

function esc(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
}

function keyOf(name: string, labels: Labels): string {
  const ks = Object.keys(labels).sort();
  if (ks.length === 0) return name;
  return `${name}{${ks.map((k) => `${k}="${esc(labels[k])}"`).join(",")}}`;
}

export class Metrics {
  private counters = new Map<string, number>();
  private gauges = new Map<string, number>();
  private sums = new Map<string, number>();
  private counts = new Map<string, number>();

  inc(name: string, labels: Labels = {}, value = 1): void {
    const k = keyOf(name, labels);
    this.counters.set(k, (this.counters.get(k) ?? 0) + value);
  }

  set(name: string, value: number): void {
    this.gauges.set(name, value);
  }

  observe(name: string, valueSeconds: number, labels: Labels = {}): void {
    const k = keyOf(name, labels);
    this.sums.set(k, (this.sums.get(k) ?? 0) + valueSeconds);
    this.counts.set(k, (this.counts.get(k) ?? 0) + 1);
  }

  /** Compatibilidad con tests: devuelve el valor actual de un contador. */
  get(name: string, labels: Labels = {}): number {
    return this.counters.get(keyOf(name, labels)) ?? 0;
  }

  reset(): void {
    this.counters.clear();
    this.gauges.clear();
    this.sums.clear();
    this.counts.clear();
  }

  render(): string {
    const names = new Set<string>([
      ...[...this.counters.keys()].map((k) => k.split("{")[0]),
      ...this.gauges.keys(),
      ...[...this.sums.keys()].map((k) => k.split("{")[0]),
    ]);
    const out: string[] = [];
    for (const name of [...names].sort()) {
      const help = HELP[name] ?? name;
      const type = TYPE[name] ?? "untyped";
      out.push(`# HELP ${name} ${help}.`);
      out.push(`# TYPE ${name} ${type}.`);
      for (const [k, v] of this.counters) {
        if (k === name || k.startsWith(name + "{")) out.push(`${k} ${v}`);
      }
      if (this.gauges.has(name)) out.push(`${name} ${this.gauges.get(name)}`);
      for (const [k, s] of this.sums) {
        if (k === name || k.startsWith(name + "{")) {
          const c = this.counts.get(k) ?? 0;
          out.push(`${k}_sum ${s}`);
          out.push(`${k}_count ${c}`);
        }
      }
    }
    return out.join("\n") + "\n";
  }
}

/** Registro global del proceso. */
export const metrics = new Metrics();
