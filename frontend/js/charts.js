// Dashboard charts (Chart.js 4 from the CDN, window.BpesCharts). Every chart lives in a fixed-height
// .bpes-chart box with an empty-state message, so nothing shifts while data loads and an empty term
// never shows a bare axis. A chart is always destroyed before it is redrawn (tabs reload their data),
// and every canvas gets a text summary as its aria-label; the legends carry counts and percentages so
// colour is never the only signal.
(function (root) {
  const COLORS = { present: '#15803D', late: '#D97706', excused: '#0369A1', absent: '#B91C1C', bar: '#14532D', grid: '#E3EEE7', text: '#4A6B5A' };
  const LABELS = { present: 'Present', late: 'Late', excused: 'Excused', absent: 'Absent' };
  const STATUSES = ['present', 'late', 'excused', 'absent'];

  const reducedMotion = () => !!(root.matchMedia && root.matchMedia('(prefers-reduced-motion: reduce)').matches);
  const animation = () => (reducedMotion() ? false : { duration: 450 });

  // 'YYYY-MM-DD' -> 'Nov 11' (calendar math only, no time zone)
  function shortDate(iso) {
    const [y, m, d] = String(iso).split('-').map(Number);
    return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
  }

  // Find the chart's box, clear the previous chart, and show either the canvas or its empty message.
  function prepare(id, isEmpty, emptyMessage) {
    const canvas = document.getElementById(id);
    if (!canvas) return null;
    if (typeof Chart !== 'undefined') Chart.getChart(canvas)?.destroy();
    const empty = canvas.closest('.bpes-chart')?.querySelector('.bpes-chart-empty');
    const unavailable = typeof Chart === 'undefined';
    const hide = isEmpty || unavailable;
    const wrap = canvas.closest('.bpes-chart');
    if (wrap) { wrap.classList.toggle('is-empty', hide); if (hide) wrap.style.height = ''; }
    canvas.classList.toggle('d-none', hide);
    if (empty) {
      empty.classList.toggle('d-none', !hide);
      if (unavailable) empty.textContent = 'Charts could not be loaded. Check your connection and reload the page.';
      else if (isEmpty && emptyMessage) empty.textContent = emptyMessage;
    }
    return hide ? null : canvas;
  }

  const baseOptions = () => ({
    responsive: true,
    maintainAspectRatio: false,
    animation: animation(),
    font: { family: 'Inter, sans-serif' },
  });

  const pct = (n, total) => (total ? Math.round((n / total) * 100) : 0);

  // Today's / this term's status mix. counts = { present, late, excused, absent }.
  function statusDonut(id, counts, legendId, emptyMessage) {
    const total = STATUSES.reduce((n, s) => n + (counts?.[s] || 0), 0);
    const legend = legendId && document.getElementById(legendId);
    const canvas = prepare(id, total === 0, emptyMessage || 'No attendance records yet.');
    if (legend) {
      legend.innerHTML = STATUSES.map(s => `
        <li><span class="bpes-legend-swatch" style="background:${COLORS[s]}"></span>
          <span class="bpes-legend-label">${LABELS[s]}</span>
          <span class="bpes-legend-value">${counts?.[s] || 0}${total ? ` <small>(${pct(counts?.[s] || 0, total)}%)</small>` : ''}</span></li>`).join('');
    }
    if (!canvas) return null;
    canvas.setAttribute('aria-label', 'Attendance mix: ' + STATUSES.map(s => `${LABELS[s].toLowerCase()} ${counts[s] || 0} (${pct(counts[s] || 0, total)}%)`).join(', '));
    return new Chart(canvas, {
      type: 'doughnut',
      data: {
        labels: STATUSES.map(s => LABELS[s]),
        datasets: [{ data: STATUSES.map(s => counts[s] || 0), backgroundColor: STATUSES.map(s => COLORS[s]), borderColor: '#FFFFFF', borderWidth: 3, hoverOffset: 6 }],
      },
      options: {
        ...baseOptions(),
        cutout: '64%',
        plugins: {
          legend: { display: false },
          tooltip: { callbacks: { label: c => ` ${c.label}: ${c.parsed} (${pct(c.parsed, total)}%)` } },
        },
      },
    });
  }

  // Daily attendance as stacked columns. days = [{ date, present, late, excused, absent, total, rate }].
  function trendBars(id, days, emptyMessage) {
    const canvas = prepare(id, !days || days.length === 0, emptyMessage || 'No classes have been held in this period yet.');
    if (!canvas) return null;
    const latest = days[days.length - 1];
    canvas.setAttribute('aria-label', `Attendance over the last ${days.length} school day${days.length === 1 ? '' : 's'}. Latest, ${shortDate(latest.date)}: ${latest.rate ?? 0}% attended.`);
    return new Chart(canvas, {
      type: 'bar',
      data: {
        labels: days.map(d => shortDate(d.date)),
        datasets: STATUSES.map(s => ({ label: LABELS[s], data: days.map(d => d[s]), backgroundColor: COLORS[s], borderRadius: 3, borderSkipped: false, maxBarThickness: 36 })),
      },
      options: {
        ...baseOptions(),
        interaction: { mode: 'index', intersect: false },
        scales: {
          x: { stacked: true, grid: { display: false }, ticks: { color: COLORS.text, maxRotation: 0, autoSkip: true } },
          y: { stacked: true, beginAtZero: true, grid: { color: COLORS.grid }, ticks: { color: COLORS.text, precision: 0 } },
        },
        plugins: {
          legend: { position: 'bottom', labels: { usePointStyle: true, boxWidth: 8, color: COLORS.text, padding: 22 } },
          tooltip: { callbacks: { footer: items => `Attendance rate: ${days[items[0].dataIndex].rate ?? 0}%` } },
        },
      },
    });
  }

  // One horizontal bar per item. items = [{ label, value }]. The box grows with the number of bars.
  function barList(id, items, unit, emptyMessage) {
    const canvas = prepare(id, !items || items.length === 0, emptyMessage || 'Nothing to show yet.');
    if (!canvas) return null;
    const box = canvas.closest('.bpes-chart');
    if (box) box.style.height = `${Math.max(180, items.length * 38 + 48)}px`;
    canvas.setAttribute('aria-label', `${unit || 'Count'} by group: ` + items.map(i => `${i.label} ${i.value}`).join(', '));
    return new Chart(canvas, {
      type: 'bar',
      data: { labels: items.map(i => i.label), datasets: [{ label: unit || 'Count', data: items.map(i => i.value), backgroundColor: COLORS.bar, borderRadius: 6, maxBarThickness: 22 }] },
      options: {
        ...baseOptions(),
        indexAxis: 'y',
        scales: {
          x: { beginAtZero: true, grid: { color: COLORS.grid }, ticks: { color: COLORS.text, precision: 0 } },
          y: { grid: { display: false }, ticks: { color: COLORS.text } },
        },
        plugins: { legend: { display: false } },
      },
    });
  }

  root.BpesCharts = { statusDonut, trendBars, barList, shortDate };
})(typeof window !== 'undefined' ? window : globalThis);
