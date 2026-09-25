/* global document, fetch, setInterval, setTimeout, clearTimeout */

const providerGrid = document.querySelector('#provider-grid');
const updatedAt = document.querySelector('#updated-at');
const discordStatus = document.querySelector('#discord-status');
const refreshInterval = document.querySelector('#refresh-interval');
const refreshButton = document.querySelector('#refresh-button');
const toast = document.querySelector('#toast');

const providerOrder = ['claude', 'codex'];
const thresholdDrafts = new Map();
let toastTimer;
let currentSettings = null;
let currentProviders = [];
let controlsBusy = false;

function formatDate(value) {
  if (!value) return '未定';
  return new Intl.DateTimeFormat('ja-JP', {
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(value));
}

function formatCountdown(value) {
  if (!value) return '時刻未定';
  const milliseconds = Math.max(0, new Date(value).getTime() - Date.now());
  const totalMinutes = Math.ceil(milliseconds / 60_000);
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;
  if (days > 0) return `あと ${days}日 ${hours}時間`;
  if (hours > 0) return `あと ${hours}時間 ${minutes}分`;
  return `あと ${minutes}分`;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function meterClass(remaining) {
  if (remaining <= 10) return 'critical';
  if (remaining <= 20) return 'warning';
  return '';
}

function settingRow(providerId, setting, title, detail, checked) {
  return `
    <label class="setting-row">
      <span><strong>${title}</strong><small>${detail}</small></span>
      <input
        type="checkbox"
        data-provider="${providerId}"
        data-setting="${setting}"
        ${checked ? 'checked' : ''}
        ${controlsBusy ? 'disabled' : ''}
      />
    </label>`;
}

function providerCard(provider) {
  const providerId = provider.id;
  const settings = currentSettings.providers[providerId];
  if (!settings) return '';
  const isClaude = providerId === 'claude';
  const mark = isClaude ? 'C' : 'O';
  const maker = isClaude ? 'ANTHROPIC' : 'OPENAI';
  const thresholds = thresholdDrafts.get(providerId) ?? settings.remainingThresholds;
  const thresholdText = settings.remainingThresholds.join('・');
  const windows = provider.windows
    .map((window) => {
      const remaining = Math.round(window.remainingPercent);
      return `
        <div class="window">
          <div class="window-top">
            <div>
              <span class="window-label">${escapeHtml(window.label)}</span>
              <p class="reset-time">${formatCountdown(window.resetsAt)}<span>·</span>${formatDate(window.resetsAt)}</p>
            </div>
            <span class="remaining">${remaining}<small>%</small><em>残り</em></span>
          </div>
          <div class="meter" aria-label="${escapeHtml(window.label)} ${remaining}%残り">
            <span class="${meterClass(remaining)}" style="width:${remaining}%"></span>
          </div>
        </div>`;
    })
    .join('');
  const thresholdInputs = [0, 1, 2]
    .map(
      (index) => `
        <label>
          <span>通知 ${index + 1}</span>
          <span><input
            type="number"
            min="0"
            max="100"
            step="1"
            inputmode="numeric"
            value="${thresholds[index] ?? ''}"
            data-provider="${providerId}"
            data-threshold-index="${index}"
            ${controlsBusy ? 'disabled' : ''}
          />%</span>
        </label>`,
    )
    .join('');

  return `
    <article class="provider-card provider-${providerId}" data-provider-card="${providerId}">
      <header class="provider-heading">
        <div class="provider-identity">
          <span class="provider-mark ${providerId}">${mark}</span>
          <div><p>${maker}</p><h3>${escapeHtml(provider.name)}</h3></div>
        </div>
        <span class="notification-state ${settings.notificationsEnabled ? 'is-on' : ''}">
          <i></i>通知 ${settings.notificationsEnabled ? 'ON' : 'OFF'}
        </span>
      </header>

      <section class="capacity-section" aria-label="${escapeHtml(provider.name)}の残り使用量">
        <div class="subheading"><span>残り使用量</span><small>${provider.windows.length}つの制限枠</small></div>
        <div class="window-list">${windows}</div>
      </section>

      <section class="provider-settings" aria-label="${escapeHtml(provider.name)}の通知設定">
        <div class="subheading"><span>通知設定</span><small>このサービスだけに適用</small></div>
        <div class="settings-list">
          ${settingRow(providerId, 'notificationsEnabled', '通知全体', `${provider.name}のDiscord通知`, settings.notificationsEnabled)}
          ${settingRow(providerId, 'thresholdNotificationsEnabled', '残量アラート', `残量${thresholdText}%で通知`, settings.thresholdNotificationsEnabled)}
          ${settingRow(providerId, 'resetNotificationsEnabled', 'リセット通知', '100%への復帰を通知', settings.resetNotificationsEnabled)}
          ${settingRow(providerId, 'errorNotificationsEnabled', '監視エラー', '認証切れなどの異常', settings.errorNotificationsEnabled)}
        </div>

        <form class="threshold-form" data-threshold-form="${providerId}">
          <div class="form-heading"><strong>通知する残量</strong><small>0〜100%・最大3段階</small></div>
          <div class="threshold-inputs">${thresholdInputs}</div>
          <button class="save-button" type="submit" ${controlsBusy ? 'disabled' : ''}>${provider.name}の設定を保存</button>
        </form>

        <div class="test-actions">
          <span><strong>配信テスト</strong><small>実際の残量は変わりません</small></span>
          <div>
            <button type="button" data-test="connection" data-provider="${providerId}" ${controlsBusy || !currentSettings.discordEnabled ? 'disabled' : ''}>通常</button>
            <button type="button" data-test="reset" data-provider="${providerId}" ${controlsBusy || !currentSettings.discordEnabled ? 'disabled' : ''}>100%復帰</button>
          </div>
        </div>
      </section>
    </article>`;
}

function renderProviders() {
  if (!currentSettings || currentProviders.length === 0) return;
  const ordered = [...currentProviders].sort(
    (left, right) => providerOrder.indexOf(left.id) - providerOrder.indexOf(right.id),
  );
  providerGrid.innerHTML = ordered.map(providerCard).join('');
}

function applyStatus(status) {
  currentProviders = status.providers;
  currentSettings = status.settings;
  renderProviders();
  updatedAt.textContent = status.updatedAt
    ? `最終更新 ${formatDate(status.updatedAt)}`
    : '初回データを取得しています…';
  discordStatus.textContent = status.settings.discordEnabled ? '接続中' : '停止中';
  discordStatus.classList.toggle('is-off', !status.settings.discordEnabled);
  refreshInterval.textContent = `${status.refreshSeconds}秒`;
}

async function requestJson(path, options = {}) {
  const response = await fetch(path, {
    cache: 'no-store',
    headers: { 'content-type': 'application/json', ...(options.headers ?? {}) },
    ...options,
  });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error ?? `HTTP ${response.status}`);
  return body;
}

async function refreshStatus(manual = false) {
  try {
    if (manual) refreshButton.disabled = true;
    const status = await requestJson(manual ? '/api/refresh' : '/api/status', {
      method: manual ? 'POST' : 'GET',
    });
    applyStatus(status);
    if (manual) showToast('Claude と Codex の使用量を更新しました');
    return status.refreshSeconds;
  } catch (error) {
    updatedAt.textContent = 'データを取得できませんでした';
    if (manual) showToast(error.message, true);
    return 30;
  } finally {
    refreshButton.disabled = false;
  }
}

async function updateSetting(input) {
  const providerId = input.dataset.provider;
  const setting = input.dataset.setting;
  const previous = !input.checked;
  setControlsBusy(true);
  try {
    const body = await requestJson('/api/settings', {
      method: 'PATCH',
      body: JSON.stringify({ providerId, [setting]: input.checked }),
    });
    currentSettings = body.settings;
    showToast(`${providerName(providerId)}の通知設定を保存しました`);
  } catch (error) {
    input.checked = previous;
    showToast(error.message, true);
  } finally {
    setControlsBusy(false);
  }
}

async function sendTest(button) {
  const providerId = button.dataset.provider;
  setControlsBusy(true);
  try {
    await requestJson(`/api/test-discord?kind=${button.dataset.test}&provider=${providerId}`, {
      method: 'POST',
    });
    showToast(
      `${providerName(providerId)}の${button.dataset.test === 'reset' ? '100%復帰' : '通常'}テストを送信しました`,
    );
  } catch (error) {
    showToast(error.message, true);
  } finally {
    setControlsBusy(false);
  }
}

async function saveRemainingThresholds(providerId) {
  const values = [
    ...providerGrid.querySelectorAll(`[data-provider="${providerId}"][data-threshold-index]`),
  ]
    .map((input) => input.value.trim())
    .filter((value) => value !== '')
    .map(Number);
  if (
    values.length === 0 ||
    values.some((value) => !Number.isInteger(value) || value < 0 || value > 100)
  ) {
    showToast('残量は0〜100の整数で1つ以上入力してください', true);
    return;
  }
  const remainingThresholds = [...new Set(values)].sort((left, right) => right - left);
  setControlsBusy(true);
  try {
    const body = await requestJson('/api/settings', {
      method: 'PATCH',
      body: JSON.stringify({ providerId, remainingThresholds }),
    });
    thresholdDrafts.delete(providerId);
    currentSettings = body.settings;
    showToast(`${providerName(providerId)}は残量${remainingThresholds.join('・')}%で通知します`);
  } catch (error) {
    showToast(error.message, true);
  } finally {
    setControlsBusy(false);
  }
}

function setControlsBusy(busy) {
  controlsBusy = busy;
  renderProviders();
}

function providerName(providerId) {
  return providerId === 'claude' ? 'Claude' : 'Codex';
}

function showToast(message, isError = false) {
  clearTimeout(toastTimer);
  toast.textContent = message;
  toast.classList.toggle('error', isError);
  toast.classList.add('visible');
  toastTimer = setTimeout(() => toast.classList.remove('visible'), 3200);
}

providerGrid.addEventListener('change', (event) => {
  const input = event.target.closest('[data-setting]');
  if (input) void updateSetting(input);
});

providerGrid.addEventListener('input', (event) => {
  const input = event.target.closest('[data-threshold-index]');
  if (!input) return;
  const providerId = input.dataset.provider;
  const draft = thresholdDrafts.get(providerId) ?? [
    ...currentSettings.providers[providerId].remainingThresholds,
  ];
  draft[Number(input.dataset.thresholdIndex)] = input.value;
  thresholdDrafts.set(providerId, draft);
});

providerGrid.addEventListener('submit', (event) => {
  const form = event.target.closest('[data-threshold-form]');
  if (!form) return;
  event.preventDefault();
  void saveRemainingThresholds(form.dataset.thresholdForm);
});

providerGrid.addEventListener('click', (event) => {
  const button = event.target.closest('[data-test]');
  if (button) void sendTest(button);
});

refreshButton.addEventListener('click', () => void refreshStatus(true));

void refreshStatus().then((seconds) => setInterval(() => void refreshStatus(), seconds * 1000));
