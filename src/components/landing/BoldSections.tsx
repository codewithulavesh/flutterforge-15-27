const METRICS = [
  {
    value: '3',
    label: 'export targets',
    detail: 'Web preview plus macOS and Windows runner folders.',
  },
  {
    value: '2',
    label: 'automatic repair rounds',
    detail: 'Compiler errors return to the agent with the active file in context.',
  },
  {
    value: '1',
    label: 'project folder',
    detail: 'Source, screens and preview config live together on disk.',
  },
  {
    value: '0',
    label: 'runtime lock-in',
    detail: 'The AI writes files. It does not run your app.',
  },
] as const;

export function MetricStrip() {
  return (
    <section aria-label="FlutterForge by the numbers" className="px-4 py-10 sm:px-6">
      <div className="mx-auto grid max-w-[1440px] grid-cols-2 gap-px overflow-hidden rounded-[24px] border border-[var(--fb-line)] bg-[var(--fb-line)] lg:grid-cols-4">
        {METRICS.map((metric) => (
          <div key={metric.label} className="bg-[var(--fb-card)] p-5 sm:p-6">
            <p className="ffb-display text-[clamp(38px,5vw,60px)] leading-none">{metric.value}</p>
            <p className="mt-2 text-[10.5px] font-semibold uppercase leading-snug tracking-[0.12em]">
              {metric.label}
            </p>
            <p className="mt-2 text-[11.5px] leading-relaxed text-[var(--fb-muted)]">{metric.detail}</p>
          </div>
        ))}
      </div>
    </section>
  );
}

const COMPARE_ROWS = [
  [
    'Starting point',
    'An empty lib/main.dart and a blank scaffold.',
    'Screens, theme and navigation written from the brief.',
  ],
  [
    'First run',
    'Set up a device or web server before you see anything.',
    'Preview served inside the workspace while it builds.',
  ],
  [
    'Compiler errors',
    'Read the log, trace the file, patch by hand.',
    'Errors return to the agent with the active file; two repair rounds.',
  ],
  [
    'Project ownership',
    'Yours from the start.',
    'Yours from the start — the export is plain Flutter.',
  ],
  [
    'Added runtime',
    'None.',
    'None — the AI writes files, it does not run the app.',
  ],
] as const;

export function ComparisonTable() {
  return (
    <>
      {/* Phones stack each step. The FlutterForge column is the point of the
          section, so it cannot sit off-screen behind a horizontal scroll. */}
      <div className="space-y-3 sm:hidden">
        {COMPARE_ROWS.map(([label, blank, forge]) => (
          <div
            key={label}
            className="overflow-hidden rounded-[20px] border border-[var(--fb-line)] bg-[var(--fb-card)]"
          >
            <p className="border-b border-[var(--fb-line)] px-4 py-2.5 text-[9.5px] font-semibold uppercase tracking-[0.14em] text-[var(--fb-dim)]">
              {label}
            </p>
            <div className="px-4 py-3">
              <p className="text-[9px] font-semibold uppercase tracking-[0.12em] text-[var(--fb-dim)]">
                Starting blank
              </p>
              <p className="mt-1 text-[12px] leading-relaxed text-[var(--fb-muted)]">{blank}</p>
            </div>
            <div className="bg-[var(--fb-soft)] px-4 py-3">
              <p className="inline-flex items-center gap-1.5 text-[9px] font-semibold uppercase tracking-[0.12em]">
                <span className="h-1.5 w-1.5 rounded-full bg-[var(--fb-lime)]" />
                With FlutterForge
              </p>
              <p className="mt-1 text-[12px] leading-relaxed">{forge}</p>
            </div>
          </div>
        ))}
      </div>

      <div
        className="hidden overflow-x-auto rounded-[24px] border border-[var(--fb-line)] bg-[var(--fb-card)] sm:block"
        data-lenis-prevent
      >
        <table className="w-full border-collapse text-left">
          <thead>
            <tr className="border-b border-[var(--fb-line)]">
              <th
                scope="col"
                className="w-[17%] px-5 py-4 text-[9.5px] font-semibold uppercase tracking-[0.14em] text-[var(--fb-dim)]"
              >
                Step
              </th>
              <th scope="col" className="w-[41.5%] px-5 py-4 text-[11px] font-semibold text-[var(--fb-muted)]">
                Starting blank
              </th>
              <th scope="col" className="w-[41.5%] px-5 py-4 text-[11px] font-semibold">
                <span className="inline-flex items-center gap-1.5">
                  <span className="h-1.5 w-1.5 rounded-full bg-[var(--fb-lime)]" />
                  With FlutterForge
                </span>
              </th>
            </tr>
          </thead>
          <tbody>
            {COMPARE_ROWS.map(([label, blank, forge]) => (
              <tr key={label} className="border-b border-[var(--fb-line)] last:border-b-0">
                <th
                  scope="row"
                  className="px-5 py-4 align-top text-[10px] font-semibold uppercase leading-relaxed tracking-[0.1em] text-[var(--fb-dim)]"
                >
                  {label}
                </th>
                <td className="px-5 py-4 align-top text-[12px] leading-relaxed text-[var(--fb-muted)]">{blank}</td>
                <td className="bg-[var(--fb-soft)] px-5 py-4 align-top text-[12px] leading-relaxed">{forge}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
