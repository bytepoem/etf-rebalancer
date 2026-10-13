const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const html = fs.readFileSync(path.join(__dirname, "../public/index.html"), "utf8");

// Execute the shipped functions rather than a second implementation of the ledger.
function functionSource(name) {
  const start = html.indexOf(`    function ${name}(`);
  assert.notEqual(start, -1, `Missing function: ${name}`);
  const end = html.indexOf("\n    function ", start + 1);
  return html.slice(start, end);
}

function createExecution({ shares = 1000, delta = -500, cost = "2.000", price = 3, confirm = true } = {}) {
  const fields = {
    ".asset-name": { value: "测试ETF" },
    ".asset-code": { value: "510300" },
    ".cost-price": { value: cost },
    ".current-shares": { value: String(shares) },
    ".current-price": { value: "3.000" },
    ".target-percent": { value: "50" }
  };
  const holding = {
    querySelector: (selector) => fields[selector],
    dataset: {},
    closest: () => ({ scrollIntoView() {} })
  };
  const executionPrice = { value: String(price) };
  const resultRow = {
    querySelector: (selector) => selector === ".execution-price-input"
      ? executionPrice
      : { textContent: "", replaceChildren() {} }
  };
  const item = {
    code: "510300", name: "测试ETF", currentShares: shares,
    deltaShares: delta, finalShares: shares + delta, price: 3, finalValue: (shares + delta) * 3
  };
  let savedRevision = 0;
  const errors = [];
  const context = {
    DATA_SCHEMA_VERSION: 3, MAX_ASSETS: 30, lastSavedAt: "",
    lastResult: { cashBefore: 10000, items: [item], reservedCash: 0, feeRate: 0, minimumFee: 5 },
    elements: {
      body: { querySelectorAll: () => [holding], closest: () => ({ scrollIntoView() {} }) },
      tradeBody: { querySelector: () => resultRow },
      unchangedBody: { querySelector: () => resultRow },
      cash: { value: "10000" }, reservedCash: { value: "0" },
      feeRate: { value: "0" }, minimumFee: { value: "5" }, lotSize: { value: "100" },
      results: { hidden: false }
    },
    calculateTradeFee: () => 5,
    refreshExecutionChecks: () => true,
    clearValidation() {},
    showErrors: (items) => errors.push(...items),
    formatCurrency: String, formatInteger: String,
    window: { confirm: () => confirm, matchMedia: () => ({ matches: true }) },
    updateSourceMeta() {}, updateRowControls() {}, refreshHoldingMetrics() {},
    markUnsaved: () => { savedRevision += 1; }, showStatus() {}
  };
  vm.createContext(context);
  for (const name of ["fundingTolerance", "formatPriceInput", "trimPrice", "readExecutionDetails", "applyExecutionResult", "readRawState", "normalizeDataFileState"]) {
    vm.runInContext(functionSource(name), context);
  }
  return { context, fields, item, executionPrice, errors, revision: () => savedRevision };
}

const scenarios = [
  ["profitable sale lowers cost", { price: 3 }, "1.000"],
  ["loss-making sale raises cost", { price: 1.5 }, "2.500"],
  ["sale at cost leaves cost unchanged", { price: 2 }, "2.000"],
  ["sale may reduce cost to zero", { price: 4 }, "0.000"],
  ["sale may reduce cost below zero", { price: 5 }, "-1.000"],
  ["sale from zero cost", { cost: "0.000", price: 3 }, "-3.000"],
  ["sale from negative cost", { cost: "-1.000", price: 3 }, "-5.000"],
  ["full sale clears cost", { delta: -1000 }, ""],
  ["sale with unknown cost keeps it blank", { cost: "" }, ""],
  ["buy with unknown old cost keeps it blank", { cost: "", delta: 500 }, ""],
  ["buy with zero old cost", { cost: "0.000", delta: 500 }, "1.000"],
  ["buy with negative old cost", { cost: "-1.000", delta: 500 }, "0.333"],
  ["ordinary weighted buy", { delta: 500 }, "2.333"],
  ["new position uses execution price", { shares: 0, delta: 500, cost: "" }, "3.000"],
  ["unchanged position retains cost", { delta: 0 }, "2.000"]
];

for (const [name, options, expectedCost] of scenarios) {
  test(name, () => {
    const execution = createExecution(options);
    const { context, fields, item } = execution;
    const beforeCost = fields[".cost-price"].value;
    const preview = context.readExecutionDetails(true);
    assert.equal(preview.valid, true);
    assert.equal(fields[".cost-price"].value, beforeCost, "Preview must not write holdings");
    context.applyExecutionResult();
    assert.equal(fields[".cost-price"].value, expectedCost);
    assert.equal(Number(fields[".current-shares"].value), item.finalShares);
    assert.equal(Number(context.elements.cash.value), item.deltaShares === 0
      ? 10000 : 10000 - item.deltaShares * Number(execution.executionPrice.value) - 5);
    // Both file and browser saves serialize this state and normalize it on restore.
    const restored = context.normalizeDataFileState(JSON.parse(JSON.stringify(context.readRawState())));
    assert.equal(Number(restored.assets[0].cost), Number(expectedCost));
    assert.equal(restored.assets[0].cost === "", expectedCost === "");
  });
}

test("latest execution price controls writeback", () => {
  const { context, fields, executionPrice } = createExecution();
  context.readExecutionDetails();
  executionPrice.value = "3.5";
  context.applyExecutionResult();
  assert.equal(fields[".cost-price"].value, "0.500");
});

test("confirmation cancellation leaves all inputs unchanged", () => {
  const { context, fields, revision } = createExecution({ confirm: false });
  context.applyExecutionResult();
  assert.equal(fields[".cost-price"].value, "2.000");
  assert.equal(fields[".current-shares"].value, "1000");
  assert.equal(context.elements.cash.value, "10000");
  assert.equal(revision(), 0);
});

test("invalid execution price blocks writeback", () => {
  const { context, fields, errors, revision } = createExecution({ price: 0 });
  context.applyExecutionResult();
  assert.ok(errors.length > 0);
  assert.equal(fields[".cost-price"].value, "2.000");
  assert.equal(fields[".current-shares"].value, "1000");
  assert.equal(revision(), 0);
});

test("cost overflow blocks writeback", () => {
  const { context, fields, errors, revision } = createExecution({ cost: "1e308" });
  context.applyExecutionResult();
  assert.ok(errors.length > 0);
  assert.equal(fields[".cost-price"].value, "1e308");
  assert.equal(fields[".current-shares"].value, "1000");
  assert.equal(revision(), 0);
});

test("unknown, zero, and negative costs remain distinct on import", () => {
  for (const cost of ["", "0", "-1.25"]) {
    const { context } = createExecution({ cost });
    const restored = context.normalizeDataFileState(context.readRawState());
    assert.equal(restored.assets[0].cost, cost);
  }
});
