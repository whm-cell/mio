const apiPrefix = '/api/v1/ops/compute';
const root = document.querySelector('#root');
const sync = document.querySelector('#sync');
const resources = { total: '总槽', encode: '编码', probe: '探测' };
const labels = {
  online: '在线',
  stale: '数据过期',
  offline: '离线',
  unseen: '尚无心跳',
  queued: '待槽',
  active: '占槽中',
  released: '已释放',
  cancelled: '已取消',
  unknown: '占槽不确定',
  pending: '待生效',
  applied: '已生效',
  rejected: '已拒绝',
};
const limitErrors = {
  WORKER_REVISION_CONFLICT: '其他操作员已更新修订。取消修改后可按最新配置重填。',
  WORKER_HARD_LIMIT_EXCEEDED: '提交值超过部署硬上限，请检查三个资源的上限。',
  WORKER_NOT_OBSERVED: '尚无 Worker 快照，收到心跳后可调整。',
  HARD_LIMIT_EXCEEDED: 'Worker 拒绝了配置，提交值超出当前部署硬上限。',
  STALE_REVISION: 'Worker 已处理更新的修订。',
  INSTANCE_MISMATCH: 'Worker 实例身份与目标不一致。',
  LIMITS_INVALID: 'Worker 拒绝了无效上限。',
};
const displayTime = new Intl.DateTimeFormat('zh-CN', {
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
});
const displayDate = new Intl.DateTimeFormat('zh-CN', {
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});
const minutes = new Intl.DateTimeFormat('zh-CN', {
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});
const fmt = (at) => (at ? displayDate.format(new Date(at)) : '—');
const limitsText = (limits) =>
  limits ? `${limits.total} / ${limits.encode} / ${limits.probe}` : '—';

function node(kind, text, className) {
  const element = document.createElement(kind);
  if (text != null) element.textContent = text;
  if (className) element.className = className;
  return element;
}

function link(text, href) {
  const element = node('a', text, 'identifier');
  element.href = href;
  return element;
}

function pill(state) {
  return node('span', labels[state] ?? state, `status-pill ${state}`);
}

function heading(title, subtitle) {
  const section = node('div', null, 'page-heading');
  section.append(node('h1', title));
  if (subtitle) section.append(node('p', subtitle, 'muted'));
  return section;
}

function panel(title, content) {
  const section = node('section', null, 'panel');
  const label = node('div', null, 'panel-heading');
  label.append(node('h2', title));
  section.append(label, content);
  return section;
}

function table(headings, rows, empty) {
  if (!rows.length) return node('p', empty, 'notice');
  const wrapper = node('div', null, 'table-wrap');
  const result = node('table');
  const head = result.createTHead().insertRow();
  for (const label of headings) {
    const th = node('th', label);
    th.scope = 'col';
    head.append(th);
  }
  const body = result.createTBody();
  for (const data of rows) {
    const row = body.insertRow();
    for (const value of data) {
      const cell = row.insertCell();
      if (value instanceof Node) cell.append(value);
      else cell.textContent = value ?? '—';
    }
  }
  wrapper.append(result);
  return wrapper;
}

async function api(path, signal, init = {}) {
  const timeout = AbortSignal.timeout(init.method === 'PUT' ? 15_000 : 4_000);
  const response = await fetch(apiPrefix + path, {
    ...init,
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    credentials: 'same-origin',
    cache: 'no-store',
  });
  if (response.ok) return response.json();
  const body = await response.json().catch(() => null);
  throw new Error(body?.error?.code ?? 'COMPUTE_OPS_UNAVAILABLE');
}

function workersTable(workers) {
  return table(
    ['Worker 实例', '状态', '实际 / 生效上限', '待槽', '最近观测'],
    workers.map((worker) => {
      const snapshot = worker.snapshot;
      const status = pill(worker.status);
      if (worker.draining) status.append(' · 排空中');
      return [
        link(worker.instanceId, `#workers/${worker.instanceId}`),
        status,
        snapshot ? `${snapshot.usage.total} / ${snapshot.limits.applied.total}` : '—',
        snapshot?.waiting.total,
        fmt(worker.observedAt),
      ];
    }),
    '尚未配置 Worker 实例。',
  );
}

function svg(kind, attrs = {}, text) {
  const element = document.createElementNS('http://www.w3.org/2000/svg', kind);
  for (const [name, value] of Object.entries(attrs)) element.setAttribute(name, value);
  if (text != null) element.textContent = text;
  return element;
}

function draw(plot, history, metric) {
  if (!history.points.length) {
    plot.replaceChildren(node('p', '这个时间范围内没有采样。', 'notice'));
    return;
  }
  const width = Math.max(285, Math.min(960, plot.clientWidth || 960));
  const right = width - 10;
  const height = width < 520 ? 160 : 190;
  const left = 30;
  const top = 8;
  const bottom = height - 22;
  const start = Date.parse(history.since);
  const end = Date.parse(history.until);
  const timed = history.points.map((point) => ({ ...point, time: Date.parse(point.at) }));
  const max = Math.max(
    1,
    ...timed.map((point) =>
      Math.max(point.hard[metric], point.usage[metric], point.applied[metric]),
    ),
  );
  const x = (time) => left + ((time - start) * (right - left)) / (end - start);
  const y = (value) => bottom - (value / max) * (bottom - top);
  const chart = svg('svg', {
    viewBox: `0 0 ${width} ${height}`,
    role: 'img',
    'aria-label': `${resources[metric]}实际占用、生效上限与部署硬上限。采样缺口处曲线断开。`,
  });
  const ticks = Math.min(4, max);
  for (let i = 0; i <= ticks; i++) {
    const value = Math.round((i * max) / ticks);
    chart.append(svg('line', { x1: left, x2: right, y1: y(value), y2: y(value), class: 'rule' }));
    chart.append(
      svg('text', { x: left - 7, y: y(value) + 4, class: 'axis', 'text-anchor': 'end' }, value),
    );
  }
  const marks = width < 520 ? 3 : 5;
  for (let i = 0; i < marks; i++) {
    const time = start + ((end - start) * i) / (marks - 1);
    chart.append(
      svg(
        'text',
        {
          x: x(time),
          y: height - 4,
          class: 'axis',
          'text-anchor': i === 0 ? 'start' : i === marks - 1 ? 'end' : 'middle',
        },
        minutes.format(time),
      ),
    );
  }
  const gaps = timed.map(
    (point, index) =>
      index > 0 &&
      (point.time - timed[index - 1].time > 15_000 ||
        point.gap ||
        (point.bootId && point.bootId !== timed[index - 1].bootId)),
  );
  for (let i = 1; i < timed.length; i++) {
    if (!gaps[i]) continue;
    const leftEdge = x(timed[i - 1].time);
    const area = svg('rect', {
      x: leftEdge,
      y: top,
      width: Math.max(1, x(timed[i].time) - leftEdge),
      height: bottom - top,
      class: 'missing',
    });
    area.append(svg('title', {}, '采样缺口'));
    chart.append(area);
  }
  for (let i = 0; i < timed.length; i++) {
    const point = timed[i];
    if (point.usage[metric] <= point.applied[metric]) continue;
    const until = Math.min(timed[i + 1]?.time ?? end, point.time + 5_000);
    const region = svg('rect', {
      x: x(point.time),
      y: top,
      width: Math.max(2, x(until) - x(point.time)),
      height: bottom - top,
      class: 'drain-range',
    });
    region.append(svg('title', {}, '采样时处于排空'));
    chart.append(region);
  }
  for (const series of ['hard', 'applied', 'usage']) {
    const commands = timed.map(
      (point, index) =>
        `${index === 0 || gaps[index] ? 'M' : 'L'}${x(point.time).toFixed(2)},${y(point[series][metric]).toFixed(2)}`,
    );
    chart.append(svg('path', { d: commands.join(' '), class: `trace ${series}` }));
  }
  for (let i = 0; i < timed.length; i++) {
    if (timed.length > 12 && !gaps[i] && !gaps[i + 1]) continue;
    chart.append(
      svg('circle', { cx: x(timed[i].time), cy: y(timed[i].usage[metric]), r: 2.5, class: 'dot' }),
    );
  }
  plot.replaceChildren(chart);
}

function chartPanel(instance) {
  const fragment = document.querySelector('#chart-template').content.cloneNode(true);
  const section = fragment.firstElementChild;
  const plot = section.querySelector('.plot');
  let current;
  let metric = 'total';
  section.querySelector('fieldset').addEventListener('change', (event) => {
    metric = event.target.value;
    if (current) draw(plot, current, metric);
  });
  return {
    section,
    update(history) {
      current = history;
      draw(plot, history, metric);
      const parts = [];
      if (!instance && history.points.length) parts.push('汇总使用各实例 15 秒内的最近样本。');
      if (
        history.points.some(
          (point, i) =>
            point.gap ||
            (i > 0 && Date.parse(point.at) - Date.parse(history.points[i - 1].at) > 15_000),
        )
      )
        parts.push('浅色区间缺测。');
      if (history.points.some((point) => point.clockUncertain))
        parts.push('部分样本存在传输延迟或时钟偏差。');
      if (history.points.some((point) => point.usage[metric] > point.applied[metric]))
        parts.push('橙色标记超限排空采样。');
      section.querySelector('.quality').textContent = parts.join(' ');
    },
  };
}

function card(title, value, description, main) {
  const card = node('article', null, main ? 'card card-primary' : 'card');
  card.append(
    node('p', title),
    node('strong', value, 'card-value'),
    node('span', description, 'card-caption'),
  );
  return card;
}

function overview() {
  const metrics = node('div', null, 'cards');
  const workerRows = node('div');
  const chart = chartPanel();
  root.replaceChildren(
    heading('计算总览', 'Worker 执行状态和队列积压'),
    metrics,
    chart.section,
    panel('Worker 实例', workerRows),
  );
  return async (signal) => {
    const [summary, list, history] = await Promise.all([
      api('/summary', signal),
      api('/workers?limit=64', signal),
      api('/history', signal),
    ]);
    signal.throwIfAborted();
    const { aggregate, instances, outbox, peaks } = summary;
    const peak = peaks.length ? Math.max(...peaks.map((worker) => worker.peak)) : '—';
    metrics.replaceChildren(
      card(
        '实际并发',
        instances.online ? `${aggregate.usage.total} / ${aggregate.applied.total}` : '—',
        `编码 ${aggregate.usage.encode} · 探测 ${aggregate.usage.probe} · 在线实例口径`,
        true,
      ),
      card(
        '在线 Worker',
        instances.online,
        `过期 ${instances.stale} · 离线 ${instances.offline} · 待心跳 ${instances.unseen}`,
      ),
      card(
        '等待处理',
        `${aggregate.waiting.total} / ${outbox.total}`,
        'B 待槽 / A 待发 · Broker 未知',
      ),
      card(
        '单实例近期峰值',
        peak,
        `最近一小时占槽事件 · ${aggregate.heldResources} 个资源类别阻断`,
      ),
    );
    workerRows.replaceChildren(workersTable(list.workers));
    chart.update(history);
  };
}

function workerStatus(worker, article) {
  article.querySelector('.worker-name').textContent = worker.instanceId;
  article.querySelector('.heartbeat').textContent = worker.receivedAt
    ? `最近观测 ${fmt(worker.observedAt)} · A 接收 ${fmt(worker.receivedAt)}`
    : '等待第一次心跳';
  article.querySelector('.worker-status').replaceWith(pill(worker.status));
  article.querySelector('.panel-heading .status-pill').classList.add('worker-status');
  const state = worker.snapshot;
  const metrics = article.querySelector('.worker-metrics');
  const warnings = article.querySelector('.worker-warning');
  const active = article.querySelector('.worker-active');
  warnings.replaceChildren();
  if (!state) {
    metrics.replaceChildren(node('p', '尚无此实例的容量与占用记录。', 'notice'));
    active.replaceChildren(node('p', '收到心跳后显示任务。', 'notice'));
    return;
  }
  if (worker.draining)
    warnings.append(
      node('p', '排空中。存量任务继续执行，降到准入范围后接收新任务。', 'notice warn'),
    );
  if (worker.clockUncertain)
    warnings.append(node('p', '观测与接收时间相差超过 15 秒。', 'notice warn'));
  if (worker.gap)
    warnings.append(node('p', `Worker 已报告 ${worker.gap.count} 条遥测缺失。`, 'notice warn'));
  const held = Object.entries(state.holds).filter(([, items]) => items.length);
  for (const [resource, items] of held)
    warnings.append(
      node('p', `${resources[resource]} HOLD · ${items.join('、')}`, 'notice warn identifier'),
    );
  metrics.replaceChildren(
    table(
      ['资源', '实际占用', '已生效', '部署硬上限', '待槽'],
      Object.entries(resources).map(([key, name]) => [
        name,
        state.usage[key],
        state.limits.applied[key],
        state.limits.hard[key],
        state.waiting[key],
      ]),
      '',
    ),
  );
  const tasks = node('ul');
  for (const execution of state.active) {
    const item = node('li');
    item.append(
      link(execution.jobId, `#executions/${execution.executionId}`),
      document.createTextNode(` · ${resources[execution.resource]} 1 槽 · ${execution.protocol}`),
    );
    tasks.append(item);
  }
  if (worker.status !== 'online')
    active.replaceChildren(node('p', '当前占用待确认。以下为最近一次快照。', 'notice warn'), tasks);
  else
    active.replaceChildren(
      tasks.childElementCount ? tasks : node('p', '暂无占槽中的任务。', 'notice'),
    );
}

function editor(article, instanceId, refresh) {
  const form = article.querySelector('form');
  const fields = Object.keys(resources).map((key) => form.elements.namedItem(key));
  const save = form.querySelector('.primary');
  const reset = form.querySelector('.reset');
  const status = article.querySelector('.status-message');
  const revisionLabel = article.querySelector('.edit-revision');
  let draft = null;
  let basedOn = 0;
  let current;
  let writing = false;
  let feedback;
  let submission;
  const disable = (disabled) => {
    save.disabled = disabled;
    for (const field of fields) field.disabled = disabled;
  };
  function render(worker) {
    current = worker;
    const snapshot = worker.snapshot;
    disable(writing || !snapshot);
    reset.hidden = draft === null;
    reset.disabled = writing;
    if (!snapshot) {
      revisionLabel.textContent = '收到心跳后可调整';
      status.textContent = '';
      return;
    }
    for (const field of fields) field.max = snapshot.limits.hard[field.name];
    const desired = worker.desired;
    const latestRevision = Math.max(
      snapshot.limits.revision,
      desired?.revision ?? 0,
      submission?.revision ?? 0,
    );
    if (!draft && !fields.includes(document.activeElement)) {
      basedOn = latestRevision;
      const chosen =
        submission?.revision > (desired?.revision ?? 0)
          ? submission.limits
          : (desired?.limits ?? snapshot.limits.applied);
      for (const field of fields) field.value = chosen[field.name];
    }
    revisionLabel.textContent = `当前修订 #${latestRevision} · 编辑基于 #${draft?.revision ?? basedOn}`;
    let message = '';
    let error = false;
    if (submission && desired?.revision === submission.revision && desired.status !== 'pending') {
      message =
        desired.status === 'applied'
          ? `修订 #${submission.revision} 已生效，Worker 已确认。`
          : `修订 #${submission.revision} 被拒绝。${limitErrors[desired.reason] ?? ''}`;
      error = desired.status === 'rejected';
    } else if (submission && latestRevision === submission.revision) {
      message = `修订 #${submission.revision} 已保存，等待 Worker 确认。`;
    } else if (desired) {
      message = `修订 #${desired.revision} ${labels[desired.status]}。${limitErrors[desired.reason] ?? ''}`;
      error = desired.status === 'rejected';
    }
    if (feedback) {
      message = feedback;
      error = true;
    }
    if (status.textContent !== message) status.textContent = message;
    status.classList.toggle('error', error);
  }
  form.addEventListener('input', () => {
    draft ??= { revision: basedOn };
    feedback = undefined;
    if (current) render(current);
  });
  reset.addEventListener('click', () => {
    draft = null;
    feedback = undefined;
    if (current) render(current);
  });
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (writing || !current?.snapshot) return;
    const expectedRevision = draft?.revision ?? basedOn;
    const limits = Object.fromEntries(fields.map((field) => [field.name, field.valueAsNumber]));
    writing = true;
    feedback = undefined;
    render(current);
    try {
      submission = await api(`/workers/${instanceId}/limits`, undefined, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ expectedRevision, ...limits }),
      });
      draft = null;
    } catch (error) {
      feedback = limitErrors[error.message] ?? '未收到保存结果，请先查看调限审计。';
    } finally {
      writing = false;
      render(current);
      if (article.isConnected) refresh();
    }
  });
  return render;
}

function workerPage(instanceId, refresh) {
  const list = node('div');
  if (!instanceId) {
    root.replaceChildren(heading('Worker 实例'), panel('部署实例', list));
    return async (signal) => {
      const data = await api('/workers?limit=64', signal);
      signal.throwIfAborted();
      list.replaceChildren(workersTable(data.workers));
    };
  }
  const article = document
    .querySelector('#worker-template')
    .content.cloneNode(true).firstElementChild;
  const chart = chartPanel(instanceId);
  const historyLink = link('返回实例列表', '#workers');
  root.replaceChildren(heading('Worker 详情'), article, chart.section, historyLink);
  const updateForm = editor(article, instanceId, refresh);
  const id = encodeURIComponent(instanceId);
  return async (signal) => {
    const [worker, history] = await Promise.all([
      api(`/workers/${id}`, signal),
      api(`/history?instanceId=${id}`, signal),
    ]);
    signal.throwIfAborted();
    workerStatus(worker, article);
    updateForm(worker);
    chart.update(history);
  };
}

function executionPage(id, refresh) {
  const content = node('div');
  if (id) {
    root.replaceChildren(
      heading('执行详情'),
      panel('占槽与状态', content),
      link('返回任务列表', '#executions'),
    );
    return async (signal) => {
      const row = await api(`/executions/${encodeURIComponent(id)}`, signal);
      signal.throwIfAborted();
      const facts = node('dl', null, 'definition');
      const fields = [
        ['任务', row.jobId],
        ['Attempt / Inspection', row.attemptId ?? row.inspectionId],
        ['Worker', row.instanceId],
        ['资源请求', `${resources[row.resource]} · ${row.slots} 槽`],
        [
          '当前占用',
          row.state === 'unknown' ? '待确认' : row.state === 'active' ? `${row.slots} 槽` : '0 槽',
        ],
        ['占槽状态', labels[row.state]],
        ['业务状态', row.businessState],
        ['业务阶段', row.businessStage],
        ['占槽开始', row.acquiredAt ? displayTime.format(new Date(row.acquiredAt)) : '—'],
        ['占槽结束', row.endedAt ? displayTime.format(new Date(row.endedAt)) : '—'],
        [
          '占槽时长',
          row.acquiredAt && row.endedAt && Date.parse(row.endedAt) >= Date.parse(row.acquiredAt)
            ? ((Date.parse(row.endedAt) - Date.parse(row.acquiredAt)) / 1000).toFixed(3) + ' 秒'
            : '—',
        ],
      ];
      for (const [label, value] of fields)
        facts.append(node('dt', label), node('dd', value ?? '—'));
      const timeline = node('ol', null, 'timeline');
      for (const event of row.timeline) {
        const at = node('time', displayTime.format(new Date(event.at)));
        const item = node('li');
        item.append(
          at,
          document.createTextNode(
            {
              queued: '进入待槽',
              acquired: '取得资源槽',
              released: '释放资源槽',
              cancelled: '取消等待',
            }[event.detail.state] ??
              event.detail.phase ??
              event.detail.state,
          ),
        );
        timeline.append(item);
      }
      content.replaceChildren(
        facts,
        panel(
          '时间线',
          timeline.childElementCount ? timeline : node('p', '无保留事件。', 'notice'),
        ),
      );
    };
  }
  const form = node('form', null, 'filters');
  const jobLabel = node('label', '任务 ID');
  const job = node('input');
  job.name = 'jobId';
  job.placeholder = '输入任务 UUID';
  job.pattern = '[0-9A-Fa-f-]{36}';
  jobLabel.append(job);
  const filterLabel = node('label', '状态');
  const states = node('select');
  states.append(new Option('全部状态', ''));
  for (const value of ['queued', 'active', 'released', 'cancelled', 'unknown'])
    states.append(new Option(labels[value], value));
  filterLabel.append(states);
  form.append(jobLabel, filterLabel, node('button', '查询'));
  let query = new URLSearchParams();
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    query = new URLSearchParams();
    if (job.value.trim()) query.set('jobId', job.value.trim());
    if (states.value) query.set('state', states.value);
    refresh();
  });
  root.replaceChildren(heading('任务占槽'), form, panel('最近执行', content));
  return async (signal) => {
    const { executions } = await api(`/executions?${query}`, signal);
    signal.throwIfAborted();
    content.replaceChildren(
      table(
        ['任务', 'Worker', '资源', '状态', '最后观测'],
        executions.map((row) => [
          link(row.jobId, `#executions/${row.executionId}`),
          row.instanceId,
          resources[row.resource],
          pill(row.state),
          fmt(row.lastAt),
        ]),
        '尚无符合条件的执行记录。',
      ),
    );
  };
}

function auditPage() {
  const content = node('div');
  root.replaceChildren(
    heading('调限审计', '上限按总槽 / 编码 / 探测排列'),
    panel('配置变更', content),
  );
  return async (signal) => {
    const { changes } = await api('/limits', signal);
    signal.throwIfAborted();
    content.replaceChildren(
      table(
        ['修订', 'Worker', '操作者', '修改前 → 提交值', '确认'],
        changes.map((entry) => [
          `#${entry.revision}`,
          link(entry.instanceId, `#workers/${entry.instanceId}`),
          node('span', entry.requestedBy, 'identifier'),
          `${limitsText(entry.previousLimits)} → ${limitsText(entry.requestedLimits)}`,
          `${labels[entry.status]}${entry.reason ? ' · ' + entry.reason : ''} · ${fmt(entry.confirmedAt ?? entry.requestedAt)}`,
        ]),
        '尚无调限记录。',
      ),
    );
  };
}

let updater;
let activeRead;
function refresh() {
  activeRead?.abort();
  const run = new AbortController();
  activeRead = run;
  updater(run.signal)
    .then(() => {
      if (run.signal.aborted) return;
      sync.textContent = `已更新 ${displayTime.format(Date.now())}`;
      sync.classList.remove('failed');
      root.querySelector('.page-error')?.remove();
    })
    .catch((error) => {
      if (run.signal.aborted) return;
      sync.textContent = '更新失败';
      sync.classList.add('failed');
      const denied = error.message === 'UNAUTHORIZED' || error.message === 'OPS_FORBIDDEN';
      const message = denied
        ? '会话已失效或当前用户没有操作员权限。'
        : error.message === 'NOT_FOUND'
          ? '此记录暂不可用。'
          : error.message === 'QUERY_INVALID'
            ? '查询参数无效，请检查任务 ID。'
            : '暂时无法读取数据，页面将在 5 秒后重试。';
      root.querySelector('.page-error')?.remove();
      const notice = node('p', message, 'notice error page-error');
      if (denied) root.replaceChildren(heading('访问受限'), notice);
      else root.prepend(notice);
    })
    .finally(() => {
      if (!run.signal.aborted) {
        activeRead = undefined;
        root.setAttribute('aria-busy', 'false');
      }
    });
}

function open() {
  const [page, id] = location.hash.slice(1).split('/');
  const current = ['workers', 'executions', 'limits'].includes(page) ? page : 'overview';
  for (const link of document.querySelectorAll('.navigation a')) {
    if (link.hash === '#' + current) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  }
  root.setAttribute('aria-busy', 'true');
  if (current === 'workers') updater = workerPage(id, refresh);
  else if (current === 'executions') updater = executionPage(id, refresh);
  else if (current === 'limits') updater = auditPage();
  else updater = overview();
  refresh();
}

window.addEventListener('hashchange', open);
open();
setInterval(() => {
  if (!activeRead) refresh();
}, 5_000);
