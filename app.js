/* 祥燿 帳簿エージェント — vanilla JS PWA version */

const ACCOUNTS = [
  { name: "現金", type: "asset" },
  { name: "普通預金", type: "asset" },
  { name: "事業主貸", type: "asset" },
  { name: "事業主借", type: "liability" },
  { name: "未払金", type: "liability" },
  { name: "売上高（絵画）", type: "revenue" },
  { name: "売上高（コンサルティング）", type: "revenue" },
  { name: "売上高（AIツール）", type: "revenue" },
  { name: "画材費", type: "expense" },
  { name: "消耗品費", type: "expense" },
  { name: "交通費", type: "expense" },
  { name: "通信費", type: "expense" },
  { name: "地代家賃", type: "expense" },
  { name: "水道光熱費", type: "expense" },
  { name: "接待交際費", type: "expense" },
  { name: "広告宣伝費", type: "expense" },
  { name: "支払手数料", type: "expense" },
  { name: "新聞図書費", type: "expense" },
  { name: "研修費", type: "expense" },
  { name: "租税公課", type: "expense" },
  { name: "減価償却費", type: "expense" },
  { name: "雑費", type: "expense" },
];
const ACCOUNT_TYPE = Object.fromEntries(ACCOUNTS.map((a) => [a.name, a.type]));
const EXPENSE_ACCOUNTS = ACCOUNTS.filter((a) => a.type === "expense").map((a) => a.name);
const REVENUE_ACCOUNTS = ACCOUNTS.filter((a) => a.type === "revenue").map((a) => a.name);

const ENTRIES_KEY = "shoyo-ledger-entries";
const APIKEY_KEY = "shoyo-ledger-api-key";

const todayStr = () => new Date().toISOString().slice(0, 10);
const yen = (n) => `¥${Number(n || 0).toLocaleString("ja-JP")}`;
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

function loadEntries() {
  try {
    const raw = localStorage.getItem(ENTRIES_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch (e) {
    return [];
  }
}
function saveEntries(entries) {
  try {
    localStorage.setItem(ENTRIES_KEY, JSON.stringify(entries));
    return true;
  } catch (e) {
    return false;
  }
}
function loadApiKey() {
  try { return localStorage.getItem(APIKEY_KEY) || ""; } catch (e) { return ""; }
}
function saveApiKey(key) {
  try { localStorage.setItem(APIKEY_KEY, key); return true; } catch (e) { return false; }
}

const state = {
  entries: loadEntries(),
  tab: "input",
  mode: "receipt",
  draft: null,
  saving: false,
  receiptPreview: null,
  receiptData: null,
  analyzing: false,
  analyzeError: null,
  ledgerAccount: ACCOUNTS[0].name,
};

const content = document.getElementById("content");

/* ---------- rendering dispatch ---------- */
function render() {
  if (state.tab === "input") renderInput();
  else if (state.tab === "journal") renderJournal();
  else if (state.tab === "ledger") renderLedger();
  else if (state.tab === "summary") renderSummary();
}

/* ---------- tab: 仕訳入力 ---------- */
function renderInput() {
  const showForm = state.mode === "manual" || state.draft;
  content.innerHTML = `
    <div class="mode-toggle">
      <button class="mode-btn ${state.mode === "receipt" ? "active" : ""}" data-action="mode-receipt">レシート読取り</button>
      <button class="mode-btn ${state.mode === "manual" ? "active" : ""}" data-action="mode-manual">手入力</button>
    </div>
    <div id="inputArea"></div>
  `;
  const area = document.getElementById("inputArea");

  if (state.mode === "receipt" && !state.draft) {
    area.appendChild(buildReceiptCapture());
  }
  if (showForm) {
    const wrap = document.createElement("div");
    if (state.mode === "receipt") wrap.style.marginTop = "16px";
    wrap.appendChild(buildEntryForm(state.draft));
    area.appendChild(wrap);
  }

  content.querySelectorAll("[data-action='mode-receipt']").forEach((b) => b.onclick = () => { state.mode = "receipt"; state.draft = null; render(); });
  content.querySelectorAll("[data-action='mode-manual']").forEach((b) => b.onclick = () => { state.mode = "manual"; state.draft = null; render(); });
}

function buildReceiptCapture() {
  const card = document.createElement("div");
  card.className = "receipt-card";
  card.innerHTML = `
    <div class="receipt-drop" id="receiptDrop">
      ${state.receiptPreview
        ? `<img src="${state.receiptPreview}" alt="レシートプレビュー" class="receipt-preview" />`
        : `<div class="receipt-empty"><div class="receipt-empty-icon">📷</div><div>レシート・領収書の写真をタップして選択</div></div>`}
    </div>
    <input type="file" accept="image/*" capture="environment" hidden id="receiptFile" />
    <div class="receipt-actions">
      <button class="btn btn-ghost" id="reselectBtn">写真を選び直す</button>
      <button class="btn btn-primary" id="analyzeBtn" ${!state.receiptPreview || state.analyzing ? "disabled" : ""}>
        ${state.analyzing ? "AIが読み取り中…" : "AIで自動仕訳"}
      </button>
    </div>
    ${state.analyzeError ? `<div class="warn">${esc(state.analyzeError)}</div>` : ""}
    ${!loadApiKey() ? `<div class="warn">先に右上の設定(⚙)からAnthropic APIキーを登録してください。</div>` : ""}
  `;
  card.querySelector("#receiptDrop").onclick = () => card.querySelector("#receiptFile").click();
  card.querySelector("#reselectBtn").onclick = () => card.querySelector("#receiptFile").click();
  card.querySelector("#receiptFile").onchange = (e) => handleReceiptFile(e.target.files && e.target.files[0]);
  card.querySelector("#analyzeBtn").onclick = analyzeReceipt;
  return card;
}

function handleReceiptFile(file) {
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    const result = reader.result;
    state.receiptData = { base64: result.split(",")[1], mediaType: file.type || "image/jpeg" };
    state.receiptPreview = result;
    state.analyzeError = null;
    render();
  };
  reader.readAsDataURL(file);
}

async function analyzeReceipt() {
  const apiKey = loadApiKey();
  if (!apiKey) {
    state.analyzeError = "先に設定(⚙)からAnthropic APIキーを登録してください。";
    render();
    return;
  }
  if (!state.receiptData) return;
  state.analyzing = true;
  state.analyzeError = null;
  render();
  try {
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "anthropic-dangerous-direct-browser-access": "true",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-6",
        max_tokens: 1000,
        messages: [
          {
            role: "user",
            content: [
              { type: "image", source: { type: "base64", media_type: state.receiptData.mediaType, data: state.receiptData.base64 } },
              {
                type: "text",
                text:
                  "あなたは日本の個人事業主（青色申告・複式簿記）の経理担当です。添付のレシート／領収書画像を読み取り、次のJSON形式のみを出力してください。前置き、説明文、コードブロック記号（```）は一切つけないでください。\n" +
                  "{\n" +
                  '  "date": "YYYY-MM-DD",\n' +
                  '  "vendor": "店名・取引先名",\n' +
                  '  "amount": 合計金額（税込・数値のみ）,\n' +
                  '  "memo": "購入内容の簡潔な説明",\n' +
                  '  "suggested_account": "次のいずれか最も適切な勘定科目：' + EXPENSE_ACCOUNTS.join("、") + '"\n' +
                  "}\n" +
                  `読み取れない項目は画像から合理的に推測してください。日付が不明な場合は"${todayStr()}"としてください。`,
              },
            ],
          },
        ],
      }),
    });
    if (!response.ok) {
      const errBody = await response.text();
      throw new Error(`API error ${response.status}: ${errBody.slice(0, 200)}`);
    }
    const data = await response.json();
    const textBlock = (data.content || []).find((b) => b.type === "text");
    if (!textBlock) throw new Error("no text response");
    const cleaned = textBlock.text.replace(/```json|```/g, "").trim();
    const parsed = JSON.parse(cleaned);
    state.draft = {
      date: parsed.date || todayStr(),
      vendor: parsed.vendor || "",
      memo: parsed.memo || "",
      debitAccount: EXPENSE_ACCOUNTS.includes(parsed.suggested_account) ? parsed.suggested_account : "消耗品費",
      debitAmount: String(parsed.amount || ""),
      creditAccount: "事業主借",
      creditAmount: String(parsed.amount || ""),
    };
    state.receiptPreview = null;
    state.receiptData = null;
  } catch (e) {
    console.error(e);
    state.analyzeError = "AI解析に失敗しました。APIキーを確認するか、下の手入力フォームで登録してください。";
  } finally {
    state.analyzing = false;
    render();
  }
}

function buildEntryForm(initial) {
  const card = document.createElement("div");
  card.className = "form-card";

  const f = {
    date: (initial && initial.date) || todayStr(),
    vendor: (initial && initial.vendor) || "",
    memo: (initial && initial.memo) || "",
    debitAccount: (initial && initial.debitAccount) || "消耗品費",
    debitAmount: (initial && initial.debitAmount) || "",
    creditAccount: (initial && initial.creditAccount) || "事業主借",
    creditAmount: (initial && initial.creditAmount) || "",
  };

  const expenseOpts = EXPENSE_ACCOUNTS.map((a) => `<option value="${esc(a)}">${esc(a)}</option>`).join("");
  const assetOpts = ACCOUNTS.filter((a) => a.type === "asset").map((a) => `<option value="${esc(a.name)}">${esc(a.name)}</option>`).join("");
  const revenueOpts = REVENUE_ACCOUNTS.map((a) => `<option value="${esc(a)}">${esc(a)}</option>`).join("");
  const liabilityOpts = ACCOUNTS.filter((a) => a.type === "liability").map((a) => `<option value="${esc(a.name)}">${esc(a.name)}</option>`).join("");

  card.innerHTML = `
    <div class="field-row">
      <label class="field"><span>日付</span><input type="date" id="f-date" value="${esc(f.date)}" /></label>
      <label class="field field-wide"><span>摘要（取引先・内容）</span><input type="text" id="f-vendor" placeholder="例：〇〇画材店" value="${esc(f.vendor)}" /></label>
    </div>
    <div class="je-block">
      <div class="je-side">
        <div class="je-side-label">借方</div>
        <select id="f-debitAccount">
          <optgroup label="費用">${expenseOpts}</optgroup>
          <optgroup label="資産">${assetOpts}</optgroup>
          <optgroup label="収益（返金等）">${revenueOpts}</optgroup>
        </select>
        <input type="number" id="f-debitAmount" placeholder="金額" value="${esc(f.debitAmount)}" />
      </div>
      <div class="je-arrow">→</div>
      <div class="je-side">
        <div class="je-side-label">貸方</div>
        <select id="f-creditAccount">
          <optgroup label="資産・負債">${assetOpts}${liabilityOpts}</optgroup>
          <optgroup label="収益">${revenueOpts}</optgroup>
        </select>
        <input type="number" id="f-creditAmount" placeholder="金額" value="${esc(f.creditAmount)}" />
      </div>
    </div>
    <label class="field"><span>メモ</span><input type="text" id="f-memo" placeholder="任意" value="${esc(f.memo)}" /></label>
    <div class="warn" id="f-warn" hidden>借方・貸方の金額が一致していません（複式簿記の原則）</div>
    <div class="form-actions">
      ${initial ? `<button class="btn btn-ghost" id="f-cancel">キャンセル</button>` : ""}
      <button class="btn btn-primary" id="f-save">仕訳を登録する</button>
    </div>
  `;

  card.querySelector("#f-debitAccount").value = f.debitAccount;
  card.querySelector("#f-creditAccount").value = f.creditAccount;

  const debitAmt = card.querySelector("#f-debitAmount");
  const creditAmt = card.querySelector("#f-creditAmount");
  const warn = card.querySelector("#f-warn");
  const saveBtn = card.querySelector("#f-save");

  const checkBalance = () => {
    const d = Number(debitAmt.value), c = Number(creditAmt.value);
    const balanced = d > 0 && d === c;
    warn.hidden = balanced || (!debitAmt.value && !creditAmt.value);
    saveBtn.disabled = !balanced || !card.querySelector("#f-date").value;
  };
  debitAmt.oninput = () => { if (!creditAmt.value || Number(creditAmt.value) === Number(debitAmt.dataset.last || 0)) creditAmt.value = debitAmt.value; debitAmt.dataset.last = debitAmt.value; checkBalance(); };
  creditAmt.oninput = () => { if (!debitAmt.value || Number(debitAmt.value) === Number(creditAmt.dataset.last || 0)) debitAmt.value = creditAmt.value; creditAmt.dataset.last = creditAmt.value; checkBalance(); };
  card.querySelector("#f-date").oninput = checkBalance;
  checkBalance();

  if (initial) {
    card.querySelector("#f-cancel").onclick = () => { state.draft = null; render(); };
  }
  saveBtn.onclick = () => {
    const entry = {
      date: card.querySelector("#f-date").value,
      vendor: card.querySelector("#f-vendor").value,
      memo: card.querySelector("#f-memo").value,
      debitAccount: card.querySelector("#f-debitAccount").value,
      debitAmount: Number(debitAmt.value),
      creditAccount: card.querySelector("#f-creditAccount").value,
      creditAmount: Number(creditAmt.value),
    };
    saveEntry(entry);
  };

  return card;
}

function saveEntry(entry) {
  entry.id = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  state.entries.push(entry);
  const ok = saveEntries(state.entries);
  state.draft = null;
  render();
  if (ok) showHanko();
}

function showHanko() {
  const el = document.getElementById("hanko");
  el.classList.add("hanko-show");
  setTimeout(() => el.classList.remove("hanko-show"), 1400);
}

/* ---------- tab: 仕訳帳 ---------- */
function renderJournal() {
  if (state.entries.length === 0) {
    content.innerHTML = `<div class="empty-state">まだ仕訳がありません。「仕訳入力」タブから登録してください。</div>`;
    return;
  }
  const sorted = [...state.entries].sort((a, b) => (a.date < b.date ? 1 : -1));
  content.innerHTML = `<div class="journal-list">${sorted.map((e) => `
    <div class="journal-row" data-id="${esc(e.id)}">
      <div class="journal-date">${esc(e.date)}</div>
      <div class="journal-main">
        <div class="journal-vendor">${esc(e.vendor) || "（摘要なし）"}${e.memo ? " — " + esc(e.memo) : ""}</div>
        <div class="journal-je">
          <span class="je-tag je-debit">${esc(e.debitAccount)} ${yen(e.debitAmount)}</span>
          <span class="je-sep">/</span>
          <span class="je-tag je-credit">${esc(e.creditAccount)} ${yen(e.creditAmount)}</span>
        </div>
      </div>
      <button class="row-delete" title="削除">✕</button>
    </div>
  `).join("")}</div>`;

  content.querySelectorAll(".row-delete").forEach((btn) => {
    btn.onclick = (e) => {
      const id = e.target.closest(".journal-row").dataset.id;
      state.entries = state.entries.filter((en) => en.id !== id);
      saveEntries(state.entries);
      render();
    };
  });
}

/* ---------- tab: 元帳 ---------- */
function renderLedger() {
  const groups = { asset: "資産", liability: "負債", revenue: "収益", expense: "費用" };
  const optHtml = Object.keys(groups).map((t) =>
    `<optgroup label="${groups[t]}">${ACCOUNTS.filter((a) => a.type === t).map((a) => `<option value="${esc(a.name)}">${esc(a.name)}</option>`).join("")}</optgroup>`
  ).join("");

  content.innerHTML = `
    <div class="ledger-select"><select id="ledgerAccountSelect">${optHtml}</select></div>
    <div id="ledgerTableWrap"></div>
  `;
  const sel = document.getElementById("ledgerAccountSelect");
  sel.value = state.ledgerAccount;
  sel.onchange = () => { state.ledgerAccount = sel.value; renderLedgerTable(); };
  renderLedgerTable();
}

function renderLedgerTable() {
  const account = state.ledgerAccount;
  const wrap = document.getElementById("ledgerTableWrap");
  const rows = state.entries
    .filter((e) => e.debitAccount === account || e.creditAccount === account)
    .sort((a, b) => (a.date > b.date ? 1 : -1));

  if (rows.length === 0) {
    wrap.innerHTML = `<div class="empty-state">この勘定科目の記録はまだありません。</div>`;
    return;
  }

  const type = ACCOUNT_TYPE[account];
  const increasesOnDebit = type === "asset" || type === "expense";
  let balance = 0;
  const withBalance = rows.map((e) => {
    const isDebit = e.debitAccount === account;
    const amt = isDebit ? e.debitAmount : e.creditAmount;
    const delta = isDebit === increasesOnDebit ? amt : -amt;
    balance += delta;
    return { ...e, isDebit, amt, balance };
  });

  wrap.innerHTML = `
    <table class="ledger-table">
      <thead><tr><th>日付</th><th>摘要</th><th>借方</th><th>貸方</th><th>残高</th></tr></thead>
      <tbody>
        ${withBalance.map((e) => `
          <tr>
            <td>${esc(e.date)}</td>
            <td>${esc(e.vendor) || esc(e.memo) || "—"}</td>
            <td class="num">${e.isDebit ? yen(e.amt) : ""}</td>
            <td class="num">${!e.isDebit ? yen(e.amt) : ""}</td>
            <td class="num balance">${yen(e.balance)}</td>
          </tr>
        `).join("")}
      </tbody>
    </table>
  `;
}

/* ---------- tab: 集計 ---------- */
function renderSummary() {
  const totals = {};
  for (const a of ACCOUNTS) totals[a.name] = { debit: 0, credit: 0 };
  for (const e of state.entries) {
    totals[e.debitAccount].debit += Number(e.debitAmount) || 0;
    totals[e.creditAccount].credit += Number(e.creditAmount) || 0;
  }
  const totalRevenue = REVENUE_ACCOUNTS.reduce((s, a) => s + totals[a].credit - totals[a].debit, 0);
  const totalExpense = EXPENSE_ACCOUNTS.reduce((s, a) => s + totals[a].debit - totals[a].credit, 0);
  const cashLike = ["現金", "普通預金"];
  const cashBalance = cashLike.reduce((s, a) => s + totals[a].debit - totals[a].credit, 0);
  const rows = ACCOUNTS.filter((a) => totals[a.name].debit || totals[a.name].credit);

  content.innerHTML = `
    <div class="summary-cards">
      <div class="summary-card"><div class="summary-label">売上（収益合計）</div><div class="summary-value plus">${yen(totalRevenue)}</div></div>
      <div class="summary-card"><div class="summary-label">経費（費用合計）</div><div class="summary-value minus">${yen(totalExpense)}</div></div>
      <div class="summary-card"><div class="summary-label">損益</div><div class="summary-value ${totalRevenue - totalExpense >= 0 ? "plus" : "minus"}">${yen(totalRevenue - totalExpense)}</div></div>
      <div class="summary-card"><div class="summary-label">現金・預金残高</div><div class="summary-value">${yen(cashBalance)}</div></div>
    </div>
    ${rows.length === 0 ? `<div class="empty-state">まだ記録がありません。</div>` : `
    <table class="ledger-table">
      <thead><tr><th>勘定科目</th><th>借方合計</th><th>貸方合計</th></tr></thead>
      <tbody>
        ${rows.map((a) => `
          <tr>
            <td>${esc(a.name)}</td>
            <td class="num">${totals[a.name].debit ? yen(totals[a.name].debit) : ""}</td>
            <td class="num">${totals[a.name].credit ? yen(totals[a.name].credit) : ""}</td>
          </tr>
        `).join("")}
      </tbody>
    </table>`}
  `;
}

/* ---------- tab bar ---------- */
document.querySelectorAll(".tab").forEach((btn) => {
  btn.onclick = () => {
    document.querySelectorAll(".tab").forEach((b) => b.classList.remove("tab-active"));
    btn.classList.add("tab-active");
    state.tab = btn.dataset.tab;
    render();
  };
});

/* ---------- settings modal ---------- */
const settingsModal = document.getElementById("settingsModal");
const apiKeyInput = document.getElementById("apiKeyInput");
document.getElementById("settingsBtn").onclick = () => {
  apiKeyInput.value = loadApiKey();
  settingsModal.hidden = false;
};
document.getElementById("closeSettings").onclick = () => { settingsModal.hidden = true; };
document.getElementById("saveSettings").onclick = () => {
  saveApiKey(apiKeyInput.value.trim());
  settingsModal.hidden = true;
  render();
};
settingsModal.addEventListener("click", (e) => { if (e.target === settingsModal) settingsModal.hidden = true; });

/* ---------- service worker ---------- */
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("./service-worker.js").catch((e) => console.warn("SW registration failed", e));
  });
}

/* ---------- initial render ---------- */
render();
