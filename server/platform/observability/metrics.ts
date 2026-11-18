/**
 * Metrics registry with Prometheus exposition.
 *
 * Deliberately dependency-free: the platform ships to desktops and containers
 * where adding a client library is more surface area than value. Cardinality is
 * bounded so a misconfigured label (user id, file path) cannot exhaust memory.
 */

export type LabelValues = Record<string, string | number | boolean>;

interface Series {
  labels: string;
  values: Map<string, number>;
  counts?: number[];
  sum?: number;
}

interface MetricFamily {
  name: string;
  help: string;
  type: 'counter' | 'gauge' | 'histogram';
  labelNames: string[];
  series: Map<string, Series>;
  buckets?: number[];
  dropped: number;
}

const NAME_PATTERN = /^[a-z_:][a-z0-9_:]*$/;
const LABEL_PATTERN = /^[a-z_][a-z0-9_]*$/;
const MAX_SERIES_PER_METRIC = 2000;

function escapeLabel(value: string): string {
  return value.replaceAll('\\', '\\\\').replaceAll('\n', '\\n').replaceAll('"', '\\"');
}

function validateName(name: string, pattern: RegExp, kind: string): void {
  if (!pattern.test(name)) throw new Error(`Invalid ${kind} name: ${name}`);
}

function labelKey(labelNames: string[], labels: LabelValues): string {
  if (labelNames.length === 0) return '';
  const parts: string[] = [];
  for (const name of labelNames) {
    const raw = labels[name];
    if (raw === undefined) throw new Error(`Missing label "${name}".`);
    parts.push(`${name}="${escapeLabel(String(raw))}"`);
  }
  const extra = Object.keys(labels).filter((key) => !labelNames.includes(key));
  if (extra.length > 0) throw new Error(`Unexpected labels: ${extra.join(', ')}`);
  return parts.join(',');
}

export const DEFAULT_HISTOGRAM_BUCKETS = [
  0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60, 120, 300,
];

export class MetricsRegistry {
  private readonly families = new Map<string, MetricFamily>();

  counter(name: string, help: string, labelNames: string[] = []): Counter {
    const family = this.family(name, help, 'counter', labelNames);
    return new Counter(family);
  }

  gauge(name: string, help: string, labelNames: string[] = []): Gauge {
    const family = this.family(name, help, 'gauge', labelNames);
    return new Gauge(family);
  }

  histogram(name: string, help: string, labelNames: string[] = [], buckets = DEFAULT_HISTOGRAM_BUCKETS): Histogram {
    const family = this.family(name, help, 'histogram', labelNames);
    family.buckets = [...buckets].sort((a, b) => a - b);
    return new Histogram(family);
  }

  /** Render the full registry in Prometheus text exposition format. */
  render(): string {
    const lines: string[] = [];
    for (const family of [...this.families.values()].sort((a, b) => a.name.localeCompare(b.name))) {
      lines.push(`# HELP ${family.name} ${family.help.replaceAll('\n', ' ')}`);
      lines.push(`# TYPE ${family.name} ${family.type}`);
      const series = [...family.series.values()].sort((a, b) => a.labels.localeCompare(b.labels));

      for (const item of series) {
        const suffix = item.labels ? `{${item.labels}}` : '';
        if (family.type === 'histogram') {
          const buckets = family.buckets ?? DEFAULT_HISTOGRAM_BUCKETS;
          const counts = item.counts ?? [];
          let cumulative = 0;
          for (let index = 0; index < buckets.length; index += 1) {
            cumulative += counts[index] ?? 0;
            const bucketLabels = item.labels
              ? `${item.labels},le="${buckets[index]}"`
              : `le="${buckets[index]}"`;
            lines.push(`${family.name}_bucket{${bucketLabels}} ${cumulative}`);
          }
          const total = counts.reduce((sum, count) => sum + count, 0);
          const infLabels = item.labels ? `${item.labels},le="+Inf"` : 'le="+Inf"';
          lines.push(`${family.name}_bucket{${infLabels}} ${total}`);
          lines.push(`${family.name}_sum${suffix} ${item.sum ?? 0}`);
          lines.push(`${family.name}_count${suffix} ${total}`);
        } else {
          lines.push(`${family.name}${suffix} ${item.values.get('value') ?? 0}`);
        }
      }

      if (family.dropped > 0) {
        lines.push(`# ${family.name}: ${family.dropped} series dropped (cardinality cap)`);
      }
    }
    return `${lines.join('\n')}\n`;
  }

  reset(): void {
    this.families.clear();
  }

  private family(name: string, help: string, type: MetricFamily['type'], labelNames: string[]): MetricFamily {
    validateName(name, NAME_PATTERN, 'metric');
    for (const label of labelNames) validateName(label, LABEL_PATTERN, 'label');
    const existing = this.families.get(name);
    if (existing) {
      if (existing.type !== type) throw new Error(`Metric ${name} already exists as ${existing.type}.`);
      return existing;
    }
    const family: MetricFamily = { name, help, type, labelNames: [...labelNames], series: new Map(), dropped: 0 };
    this.families.set(name, family);
    return family;
  }
}

abstract class Instrument {
  constructor(protected readonly family: MetricFamily) {}

  protected series(labels: LabelValues): Series | null {
    const key = labelKey(this.family.labelNames, labels);
    const existing = this.family.series.get(key);
    if (existing) return existing;
    if (this.family.series.size >= MAX_SERIES_PER_METRIC) {
      this.family.dropped += 1;
      return null;
    }
    const series: Series =
      this.family.type === 'histogram'
        ? { labels: key, values: new Map(), counts: new Array(this.family.buckets?.length ?? 0).fill(0), sum: 0 }
        : { labels: key, values: new Map([['value', 0]]) };
    this.family.series.set(key, series);
    return series;
  }
}

export class Counter extends Instrument {
  inc(labels: LabelValues = {}, amount = 1): void {
    if (!Number.isFinite(amount) || amount < 0) throw new Error('Counters can only increase.');
    const series = this.series(labels);
    if (!series) return;
    series.values.set('value', (series.values.get('value') ?? 0) + amount);
  }
}

export class Gauge extends Instrument {
  set(value: number, labels: LabelValues = {}): void {
    if (!Number.isFinite(value)) return;
    const series = this.series(labels);
    if (!series) return;
    series.values.set('value', value);
  }

  inc(labels: LabelValues = {}, amount = 1): void {
    const series = this.series(labels);
    if (!series) return;
    series.values.set('value', (series.values.get('value') ?? 0) + (Number.isFinite(amount) ? amount : 0));
  }

  dec(labels: LabelValues = {}, amount = 1): void {
    this.inc(labels, -amount);
  }
}

export class Histogram extends Instrument {
  observe(seconds: number, labels: LabelValues = {}): void {
    if (!Number.isFinite(seconds) || seconds < 0) return;
    const series = this.series(labels);
    if (!series || !series.counts) return;
    const buckets = this.family.buckets ?? DEFAULT_HISTOGRAM_BUCKETS;
    let placed = false;
    for (let index = 0; index < buckets.length; index += 1) {
      if (seconds <= buckets[index]) {
        series.counts[index] += 1;
        placed = true;
        break;
      }
    }
    // The +Inf bucket is derived in render(), so overflow needs no slot.
    void placed;
    series.sum = (series.sum ?? 0) + seconds;
  }

  observeMs(milliseconds: number, labels: LabelValues = {}): void {
    this.observe(milliseconds / 1000, labels);
  }

  startTimer(labels: LabelValues = {}): () => number {
    const started = process.hrtime.bigint();
    return () => {
      const elapsed = Number(process.hrtime.bigint() - started) / 1e9;
      this.observe(elapsed, labels);
      return elapsed * 1000;
    };
  }
}

/** The process-wide registry plus the platform's canonical metric set. */
export const metrics = new MetricsRegistry();

export const httpRequests = metrics.counter(
  'flutterforge_http_requests_total',
  'HTTP requests processed, by route, method and status class.',
  ['method', 'route', 'status'],
);
export const httpLatency = metrics.histogram(
  'flutterforge_http_request_duration_seconds',
  'HTTP request latency.',
  ['method', 'route'],
);
export const workflowRuns = metrics.counter(
  'flutterforge_workflow_runs_total',
  'Workflow runs by terminal status.',
  ['definition', 'status'],
);
export const workflowStepLatency = metrics.histogram(
  'flutterforge_workflow_step_duration_seconds',
  'Workflow step duration.',
  ['definition', 'step', 'status'],
);
export const llmTokens = metrics.counter(
  'flutterforge_llm_tokens_total',
  'LLM tokens consumed by direction and model.',
  ['provider', 'model', 'direction'],
);
export const patchOperations = metrics.counter(
  'flutterforge_patch_operations_total',
  'Transactional patch operations.',
  ['result'],
);
export const rateLimited = metrics.counter(
  'flutterforge_rate_limited_total',
  'Requests rejected by the rate limiter.',
  ['tier'],
);
export const activeRuns = metrics.gauge(
  'flutterforge_active_workflow_runs',
  'Workflow runs currently executing.',
);
